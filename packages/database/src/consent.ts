import type { ConsentMethod, ConsentSubjectType, FileScanStatus } from '@prisma/client';

/**
 * LOCAL SHIM (DB-3) for @meetops/contracts 0.4.1 (ARC-2, feat/contracts-v0.4.1-consent-realtime), which is not on
 * integration yet. The database package does not depend on contracts, so these mirror the contract constants that
 * the consent_attestations / file_objects SQL enforces, and the type assertions below fail the build if the Prisma
 * enums drift from them. Not exported from the package entry point: callers use the contract types. When 0.4.1
 * lands, keep the values in sync with packages/contracts/src/constants.ts.
 */
export const CONSENT_SUBJECT_TYPES = ['upload', 'recording_session'] as const;
export const CONSENT_METHODS = ['all_parties_notified', 'all_parties_consented'] as const;
export const CURRENT_CONSENT_VERSION = '2026-11';
export const CONSENT_VERSION_PATTERN = '^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$';
export const CONSENT_ATTESTATION_MAX_SKEW_SECONDS = 300;
export const CONSENT_ATTESTATION_MAX_BACKDATE_SECONDS = 86_400;
export const FILE_OBJECT_SCAN_STATUSES = ['pending', 'clean', 'quarantined', 'rejected'] as const;

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Assert<T extends true> = T;

export type ShimConsentSubjectType = (typeof CONSENT_SUBJECT_TYPES)[number];
export type ShimConsentMethod = (typeof CONSENT_METHODS)[number];
export type ShimFileObjectScanStatus = (typeof FILE_OBJECT_SCAN_STATUSES)[number];

/** Compile-time: the Prisma enums equal the 0.4.1 contract unions. */
export type ConsentEnumsMatchContracts = [
  Assert<Same<ConsentSubjectType, ShimConsentSubjectType>>,
  Assert<Same<ConsentMethod, ShimConsentMethod>>,
  Assert<Same<FileScanStatus, ShimFileObjectScanStatus>>,
];
