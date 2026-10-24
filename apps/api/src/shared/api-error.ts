/**
 * The API error envelope is the contracts one (v0.3.3+, includes CSRF_INVALID and `reason`).
 * Re-exported so response schemas never drift from @meetops/contracts (a local copy used to strip `reason`).
 */
export { ApiErrorCode, ApiErrorEnvelope, ApiErrorReason } from '@meetops/contracts';
