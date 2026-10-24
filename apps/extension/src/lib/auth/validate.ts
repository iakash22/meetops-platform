/**
 * Runtime validation of every ADR-005 message and API response with TypeBox `Value.Check` against the
 * contracts schemas. This is the ONLY module in the extension that imports the contracts main entry (and with it
 * TypeBox); everything else imports `@meetops/contracts/types`. It is imported by the background worker only, so the
 * popup and offscreen bundles stay TypeBox-free.
 */
import { Value } from '@sinclair/typebox/value';
import {
  ApiErrorEnvelope,
  ExtensionTokenRequest,
  ExtensionRefreshResponse,
  ExtensionRevokeResponse,
  ExtensionTokenResponse,
  registerContractFormats,
} from '@meetops/contracts';
import { Type } from '@sinclair/typebox';
import type {
  ApiErrorEnvelope as ApiErrorT,
  ExtensionRefreshResponse as RefreshT,
  ExtensionRevokeResponse as RevokeT,
  ExtensionTokenResponse as TokenT,
} from '@meetops/contracts/types';

// contracts is sideEffects:false, so the format registration must be invoked explicitly.
registerContractFormats();

/** The `{ pairingCode, nonce }` handoff from the web page (ADR-005 A1.1.4). Strict, built from contract schemas. */
const PairingHandoff = Type.Object(
  {
    type: Type.Literal('MEETOPS_PAIRING_CODE'),
    pairingCode: ExtensionTokenRequest.properties.pairingCode,
    nonce: ExtensionTokenRequest.properties.nonce,
  },
  { additionalProperties: false },
);
export interface PairingHandoffT {
  type: 'MEETOPS_PAIRING_CODE';
  pairingCode: string;
  nonce: string;
}

export interface Validators {
  pairingHandoff(v: unknown): v is PairingHandoffT;
  tokenResponse(v: unknown): v is TokenT;
  refreshResponse(v: unknown): v is RefreshT;
  revokeResponse(v: unknown): v is RevokeT;
  apiError(v: unknown): v is ApiErrorT;
}

export const validators: Validators = {
  pairingHandoff: (v): v is PairingHandoffT => Value.Check(PairingHandoff, v),
  tokenResponse: (v): v is TokenT => Value.Check(ExtensionTokenResponse, v),
  refreshResponse: (v): v is RefreshT => Value.Check(ExtensionRefreshResponse, v),
  revokeResponse: (v): v is RevokeT => Value.Check(ExtensionRevokeResponse, v),
  apiError: (v): v is ApiErrorT => Value.Check(ApiErrorEnvelope, v),
};
