import { describe, it, expect } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import * as Full from '../src/index.js';
import * as C from '../src/constants.js';
import {
  CompleteRecordingSessionRequest,
  PAIRING_CODE_MESSAGE_TYPE,
  PairingCodeMessage,
} from '../src/index.js';

const code = 'C'.repeat(43);
const nonce = 'n'.repeat(43);
const msg = { type: 'MEETOPS_PAIRING_CODE', pairingCode: code, nonce };

describe('chunk limits live in constants.ts', () => {
  it('values', () => {
    expect(C.MAX_CHUNK_BYTES).toBe(64 * 1024 * 1024);
    expect(C.MAX_CHUNKS).toBe(10_000);
    expect(C.MAX_RECORDING_CHUNKS).toBe(C.MAX_CHUNKS);
    expect(C.MAX_DURATION_MS).toBe(14_400_000);
    expect(C.CHUNK_UPLOAD_URL_TTL_SECONDS).toBe(300);
    expect(C.MAX_RECORDING_SESSION_BYTES).toBe(C.MAX_MEDIA_BYTES);
    expect(C.MAX_MEDIA_BYTES).toBe(1_400_000_000);
  });
  it('main entry re-exports the same values', () => {
    for (const k of [
      'MAX_CHUNK_BYTES',
      'MAX_CHUNKS',
      'MAX_RECORDING_CHUNKS',
      'MAX_DURATION_MS',
      'CHUNK_UPLOAD_URL_TTL_SECONDS',
      'MAX_RECORDING_SESSION_BYTES',
      'MAX_MEDIA_BYTES',
      'PAIRING_CODE_MESSAGE_TYPE',
    ] as const) {
      expect(Full[k]).toBe(C[k]);
    }
  });
  it('durationMs is capped by MAX_DURATION_MS', () => {
    expect(
      Value.Check(CompleteRecordingSessionRequest, {
        chunkCount: 1,
        durationMs: C.MAX_DURATION_MS,
      }),
    ).toBe(true);
    expect(
      Value.Check(CompleteRecordingSessionRequest, {
        chunkCount: 1,
        durationMs: C.MAX_DURATION_MS + 1,
      }),
    ).toBe(false);
  });
});

describe('PairingCodeMessage', () => {
  it('accepts the handoff message', () => {
    expect(PAIRING_CODE_MESSAGE_TYPE).toBe('MEETOPS_PAIRING_CODE');
    expect(Value.Check(PairingCodeMessage, msg)).toBe(true);
  });
  it('rejects a wrong type, bad bounds, missing fields and extra (token) fields', () => {
    expect(Value.Check(PairingCodeMessage, { ...msg, type: 'PAIRING_CODE' })).toBe(false);
    expect(Value.Check(PairingCodeMessage, { ...msg, pairingCode: 'short' })).toBe(false);
    expect(Value.Check(PairingCodeMessage, { ...msg, pairingCode: 'C'.repeat(129) })).toBe(false);
    expect(Value.Check(PairingCodeMessage, { ...msg, pairingCode: `${'C'.repeat(40)}+/=` })).toBe(
      false,
    );
    expect(Value.Check(PairingCodeMessage, { ...msg, nonce: 'n'.repeat(31) })).toBe(false);
    expect(Value.Check(PairingCodeMessage, { type: msg.type, pairingCode: code })).toBe(false);
    expect(Value.Check(PairingCodeMessage, { ...msg, accessToken: 'a'.repeat(64) })).toBe(false);
  });
});
