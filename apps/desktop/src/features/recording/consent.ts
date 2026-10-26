import type { ConsentAttestationInput, ConsentMethod } from '@meetops/contracts';
import { CURRENT_CONSENT_VERSION } from '@meetops/contracts/types';

/** Builds the G11 attestation from the participant notice. `attestedAt` is the moment the user confirmed. */
export function toAttestation(
  method: ConsentMethod,
  at: Date = new Date(),
): ConsentAttestationInput {
  return { consentVersion: CURRENT_CONSENT_VERSION, attestedAt: at.toISOString(), method };
}

export type MicState = 'granted' | 'denied' | 'prompt' | 'unsupported';

/** Microphone permission via the webview (no plugin). Requesting opens and immediately releases a stream. */
export async function queryMic(): Promise<MicState> {
  if (!navigator.mediaDevices?.getUserMedia) return 'unsupported';
  try {
    const status = await navigator.permissions?.query({ name: 'microphone' });
    return status?.state ?? 'prompt';
  } catch {
    return 'prompt';
  }
}
