import {
  CONSENT_ATTESTATION_MAX_BACKDATE_SECONDS,
  CONSENT_ATTESTATION_MAX_SKEW_SECONDS,
  CONSENT_HTTP_STATUS,
  ConsentAttestationInput,
  CURRENT_CONSENT_VERSION,
  type ConsentErrorReason,
  type ConsentMethod,
  type ConsentSubjectType,
} from '@meetops/contracts';
import { Value } from '@sinclair/typebox/value';
import { DomainError } from '../../../shared/domain-error.js';

const MESSAGES: Record<ConsentErrorReason, string> = {
  CONSENT_REQUIRED: 'A recording consent attestation is required',
  CONSENT_VERSION_UNSUPPORTED: 'This consent notice version is not supported',
  CONSENT_INVALID: 'The consent attestation is not valid',
};

/**
 * Server-side source of the consent notice version an organization accepts right now: the org's stored
 * organization_consent_settings.current_consent_version (read inside that org's RLS context), or the global
 * CURRENT_CONSENT_VERSION when the org has no settings row. Never taken from the request.
 */
export type ConsentVersionResolver = (organizationId: string) => Promise<string>;

/** Resolver for callers with no settings store: every org accepts only the global CURRENT_CONSENT_VERSION. */
export const globalConsentVersion: ConsentVersionResolver = async () => CURRENT_CONSENT_VERSION;

/** contracts v0.4.1 (G11): 422 `VALIDATION_FAILED` + `reason` from CONSENT_ERROR_REASONS. */
export class ConsentRejectedError extends DomainError {
  constructor(public readonly consentReason: ConsentErrorReason) {
    super('VALIDATION_FAILED', MESSAGES[consentReason], CONSENT_HTTP_STATUS, consentReason);
  }
}

/** A stored consent_attestations row (DB-3), as the API sees it. */
export interface ConsentRecord {
  id: string;
  organizationId: string;
  subjectType: ConsentSubjectType;
  subjectId: string;
  consentVersion: string;
  method: ConsentMethod;
  attestedByUserId: string;
  attestedAt: Date;
  recordedAt: Date;
}

/** Append-only consent store (DB-3 grants SELECT, INSERT only). */
export interface ConsentRepository {
  record(
    r: Omit<ConsentRecord, 'id' | 'recordedAt'> & { recordedAt: Date },
  ): Promise<ConsentRecord>;
  /** Newest attestation for a subject in this org, or null. */
  findLatest(
    organizationId: string,
    subjectType: ConsentSubjectType,
    subjectId: string,
  ): Promise<ConsentRecord | null>;
}

const skewMs = CONSENT_ATTESTATION_MAX_SKEW_SECONDS * 1000;
const backdateMs = CONSENT_ATTESTATION_MAX_BACKDATE_SECONDS * 1000;

/**
 * Validates the `consent` part of an init body. Order: shape (CONSENT_REQUIRED) -> version must equal
 * `acceptedVersion`, the org's current version from a ConsentVersionResolver (CONSENT_VERSION_UNSUPPORTED) -> attestedAt not more than the max skew ahead of, nor the max back-date behind, the
 * server clock (CONSENT_INVALID).
 */
export function checkConsentInput(
  raw: unknown,
  now: Date,
  acceptedVersion: string,
): ConsentAttestationInput {
  if (raw === undefined || raw === null || !Value.Check(ConsentAttestationInput, raw)) {
    throw new ConsentRejectedError('CONSENT_REQUIRED');
  }
  if (raw.consentVersion !== acceptedVersion) {
    throw new ConsentRejectedError('CONSENT_VERSION_UNSUPPORTED');
  }
  const at = Date.parse(raw.attestedAt);
  if (!Number.isFinite(at) || at > now.getTime() + skewMs || at < now.getTime() - backdateMs) {
    throw new ConsentRejectedError('CONSENT_INVALID');
  }
  return raw;
}

/**
 * Re-checks a stored attestation before any processing job is queued. In-flight subjects are grandfathered: the
 * stored version was checked against the org's current version (under RLS) when the attestation was created, so it
 * is NOT re-checked against today's version and a later notice edit never 422s or skips the upload. The version
 * always comes from this server-stored row (never from the complete/replay request) and stays on the receipt.
 */
export function checkStoredConsent(r: ConsentRecord | null): ConsentRecord {
  if (!r) throw new ConsentRejectedError('CONSENT_REQUIRED');
  if (typeof r.consentVersion !== 'string' || r.consentVersion.length === 0) {
    throw new ConsentRejectedError('CONSENT_INVALID');
  }
  if (
    r.attestedAt.getTime() > r.recordedAt.getTime() + skewMs ||
    r.attestedAt.getTime() < r.recordedAt.getTime() - backdateMs
  ) {
    throw new ConsentRejectedError('CONSENT_INVALID');
  }
  return r;
}
