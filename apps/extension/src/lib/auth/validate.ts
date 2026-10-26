/**
 * Runtime validation of every ADR-005 message and API response with TypeBox `Value.Check` against the
 * contracts schemas. This is the ONLY module in the extension that imports the contracts main entry (and with it
 * TypeBox); everything else imports `@meetops/contracts/types`. It is imported by the background worker only, so the
 * popup and offscreen bundles stay TypeBox-free.
 */
import { Value } from '@sinclair/typebox/value';
import {
  AbortRecordingSessionRequest,
  ApiErrorEnvelope,
  ChunkUploadUrlRequest,
  ChunkUploadUrlResponse,
  CompleteRecordingSessionRequest,
  CompleteRecordingSessionResponse,
  ExtensionTokenRequest,
  ExtensionRefreshResponse,
  ExtensionRevokeResponse,
  ExtensionTokenResponse,
  InitRecordingSessionRequest,
  InitRecordingSessionResponse,
  InitUploadResponse,
  registerContractFormats,
} from '@meetops/contracts';
import { Type } from '@sinclair/typebox';
import type {
  ApiErrorEnvelope as ApiErrorT,
  InitUploadResponse as InitUploadResponseT,
  ExtensionRefreshResponse as RefreshT,
  ExtensionRevokeResponse as RevokeT,
  ExtensionTokenResponse as TokenT,
} from '@meetops/contracts/types';
import type { UploadValidators } from '../upload-http.js';

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

/** Recording-session (chunked upload) requests and responses, for HttpUploadClient and the offscreen upload RPC. */
export const uploadValidators: UploadValidators = {
  initRequest: (v): v is InitRecordingSessionRequest => Value.Check(InitRecordingSessionRequest, v),
  chunkUrlRequest: (v): v is ChunkUploadUrlRequest => Value.Check(ChunkUploadUrlRequest, v),
  completeRequest: (v): v is CompleteRecordingSessionRequest =>
    Value.Check(CompleteRecordingSessionRequest, v),
  abortRequest: (v): v is AbortRecordingSessionRequest =>
    Value.Check(AbortRecordingSessionRequest, v),
  initResponse: (v): v is InitRecordingSessionResponse =>
    Value.Check(InitRecordingSessionResponse, v),
  chunkUrlResponse: (v): v is ChunkUploadUrlResponse => Value.Check(ChunkUploadUrlResponse, v),
  completeResponse: (v): v is CompleteRecordingSessionResponse =>
    Value.Check(CompleteRecordingSessionResponse, v),
  apiError: (v): v is ApiErrorT => Value.Check(ApiErrorEnvelope, v),
};

/** Direct single-file upload (DirectUploadClient): init response and API error code. */
export const directUploadValidators = {
  isInitResponse: (v: unknown): v is InitUploadResponseT => Value.Check(InitUploadResponse, v),
  apiErrorCode: (v: unknown): string | undefined =>
    Value.Check(ApiErrorEnvelope, v) ? v.error.code : undefined,
};
