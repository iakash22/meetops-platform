import {
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

/**
 * Validates the `consent` part of an init body. Order: shape (CONSENT_REQUIRED) -> version
 * (CONSENT_VERSION_UNSUPPORTED) -> attestedAt not more than the max skew ahead of the server clock (CONSENT_INVALID).
 */
export function checkConsentInput(raw: unknown, now: Date): ConsentAttestationInput {
  if (raw === undefined || raw === null || !Value.Check(ConsentAttestationInput, raw)) {
    throw new ConsentRejectedError('CONSENT_REQUIRED');
  }
  if (raw.consentVersion !== CURRENT_CONSENT_VERSION) {
    throw new ConsentRejectedError('CONSENT_VERSION_UNSUPPORTED');
  }
  const at = Date.parse(raw.attestedAt);
  if (!Number.isFinite(at) || at > now.getTime() + skewMs) {
    throw new ConsentRejectedError('CONSENT_INVALID');
  }
  return raw;
}

/** Re-checks a stored attestation before any processing job is queued. */
export function checkStoredConsent(r: ConsentRecord | null): ConsentRecord {
  if (!r) throw new ConsentRejectedError('CONSENT_REQUIRED');
  if (r.consentVersion !== CURRENT_CONSENT_VERSION) {
    throw new ConsentRejectedError('CONSENT_VERSION_UNSUPPORTED');
  }
  if (r.attestedAt.getTime() > r.recordedAt.getTime() + skewMs) {
    throw new ConsentRejectedError('CONSENT_INVALID');
  }
  return r;
}
