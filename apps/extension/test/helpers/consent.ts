import { CURRENT_CONSENT_VERSION } from '@meetops/contracts/types';
import type { ConsentAttestationInput } from '@meetops/contracts/types';

/** A contracts v0.4.1 consent attestation, as the background builds it from the popup's confirmation. */
export const CONSENT: ConsentAttestationInput = {
  consentVersion: CURRENT_CONSENT_VERSION,
  attestedAt: '2026-10-25T07:59:30.000Z',
  method: 'all_parties_consented',
};
