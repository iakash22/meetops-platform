import { describe, expect, it } from 'vitest';
import { isBackgroundMessage, isOffscreenMessage } from '../src/lib/messages.js';
import { CONSENT } from './helpers/consent.js';

const MID = '6f1c2b8e-3d4a-4e5f-9a6b-7c8d9e0f1a2b';

describe('message guards', () => {
  it('accepts valid background messages', () => {
    expect(isBackgroundMessage({ target: 'background', type: 'GET_STATUS' })).toBe(true);
    expect(
      isBackgroundMessage({
        target: 'background',
        type: 'ACK_CONSENT',
        tabId: 1,
        meetingId: MID,
        method: 'all_parties_consented',
      }),
    ).toBe(true);
    expect(
      isBackgroundMessage({
        target: 'background',
        type: 'START_RECORDING',
        meetingId: MID,
        tabId: 1,
        streamId: 'x',
      }),
    ).toBe(true);
    expect(isBackgroundMessage({ target: 'background', type: 'REC_CHUNK', seq: 0 })).toBe(true);
  });

  it('rejects malformed or mis-targeted messages', () => {
    expect(isBackgroundMessage(null)).toBe(false);
    expect(isBackgroundMessage({ type: 'GET_STATUS' })).toBe(false);
    expect(isBackgroundMessage({ target: 'offscreen', type: 'GET_STATUS' })).toBe(false);
    expect(
      isBackgroundMessage({
        target: 'background',
        type: 'START_RECORDING',
        meetingId: MID,
        tabId: 1,
        streamId: '',
      }),
    ).toBe(false);
    expect(isBackgroundMessage({ target: 'background', type: 'ACK_CONSENT', tabId: -1 })).toBe(
      false,
    );
    expect(isBackgroundMessage({ target: 'background', type: 'ACK_CONSENT', tabId: 1 })).toBe(
      false,
    );
    expect(isBackgroundMessage({ target: 'background', type: 'EVIL' })).toBe(false);
  });

  it('validates offscreen messages', () => {
    expect(
      isOffscreenMessage({
        target: 'offscreen',
        type: 'OFFSCREEN_START',
        meetingId: MID,
        streamId: 's',
        startedAt: 1,
        consent: CONSENT,
      }),
    ).toBe(true);
    // Contracts v0.4.1: no start without a well-formed attestation.
    for (const consent of [
      undefined,
      true,
      { ...CONSENT, method: 'implied' },
      { ...CONSENT, attestedAt: 'yesterday' },
      { ...CONSENT, consentVersion: '' },
      { ...CONSENT, attestedByUserId: MID },
    ]) {
      expect(
        isOffscreenMessage({
          target: 'offscreen',
          type: 'OFFSCREEN_START',
          meetingId: MID,
          streamId: 's',
          startedAt: 1,
          consent,
        }),
      ).toBe(false);
    }
    expect(isOffscreenMessage({ target: 'offscreen', type: 'OFFSCREEN_STOP' })).toBe(true);
    expect(isOffscreenMessage({ target: 'offscreen', type: 'OFFSCREEN_DISCARD' })).toBe(true);
    expect(
      isOffscreenMessage({
        target: 'offscreen',
        type: 'OFFSCREEN_START',
        meetingId: MID,
        streamId: 's',
      }),
    ).toBe(false);
    expect(isOffscreenMessage({ target: 'background', type: 'OFFSCREEN_STOP' })).toBe(false);
  });
});
