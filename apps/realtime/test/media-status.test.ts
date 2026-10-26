import { afterEach, describe, expect, it } from 'vitest';
import {
  emitProcessingStatus,
  emitUploadStatus,
  isProcessingStatusEvent,
  isUploadStatusEvent,
  type ProcessingStatusEvent,
  type RealtimeServerToClientEvents,
  type UploadStatusEvent,
} from '../src/index.js';
import {
  MEETING_A,
  ORG_A,
  connect,
  connected,
  runCleanups,
  start,
  web,
  type C,
} from './fixtures.js';

afterEach(runCleanups);

function collect<E extends keyof RealtimeServerToClientEvents>(s: C, e: E) {
  const got: unknown[] = [];
  s.on(e, ((p: unknown) => got.push(p)) as never);
  return got;
}
const settle = () => new Promise((r) => setTimeout(r, 200));

const at = '2026-10-24T08:00:00.000Z';
const upload: UploadStatusEvent = {
  organizationId: ORG_A,
  meetingId: MEETING_A,
  uploadId: 'up1',
  status: 'verified',
  sha256: 'a'.repeat(64),
  sizeBytes: 3,
  at,
};
const processing: ProcessingStatusEvent = {
  organizationId: ORG_A,
  meetingId: MEETING_A,
  recordingId: 'r1',
  status: 'normalizing',
  percent: 5,
  at,
};

describe('media status events over Socket.IO', () => {
  it('rejects unauthenticated handshakes', async () => {
    const { url } = await start();
    await expect(connected(connect(url))).rejects.toThrow('unauthorized');
  });

  it('delivers upload:status and processing:status only to the owning organization, once per socket', async () => {
    const { io, url } = await start();
    const a1 = web(url, 'a1');
    const b1 = web(url, 'b1');
    await Promise.all([connected(a1), connected(b1)]);
    expect(await a1.emitWithAck('meeting:join', { meetingId: MEETING_A })).toEqual({ ok: true }); // in org + meeting room
    const [ua, ub, pa, pb] = [
      collect(a1, 'upload:status'),
      collect(b1, 'upload:status'),
      collect(a1, 'processing:status'),
      collect(b1, 'processing:status'),
    ];
    emitUploadStatus(io, upload);
    emitProcessingStatus(io, processing);
    await settle();
    expect(ua).toEqual([upload]);
    expect(pa).toEqual([processing]);
    expect(ub).toEqual([]);
    expect(pb).toEqual([]);
  });

  it('refuses to broadcast malformed or over-broad payloads', async () => {
    const { io } = await start();
    expect(() =>
      emitUploadStatus(io, { ...upload, key: `organizations/${ORG_A}/x` } as never),
    ).toThrow(TypeError);
    expect(() => emitUploadStatus(io, { ...upload, status: 'done' as never })).toThrow(TypeError);
    expect(() => emitUploadStatus(io, { ...upload, sha256: 'XYZ' })).toThrow(TypeError);
    expect(() => emitProcessingStatus(io, { ...processing, percent: 101 })).toThrow(TypeError);
    expect(() => emitProcessingStatus(io, { ...processing, organizationId: '../b' })).toThrow(
      TypeError,
    );
    expect(() => emitProcessingStatus(io, { ...processing, errorCode: 'Error: /tmp/x' })).toThrow(
      TypeError,
    );
  });

  it('type guards accept the documented shapes', () => {
    expect(
      isUploadStatusEvent({
        organizationId: 'o',
        meetingId: 'm',
        uploadId: 'u',
        status: 'failed',
        errorCode: 'checksum_mismatch',
        at,
      }),
    ).toBe(true);
    expect(
      isProcessingStatusEvent({
        organizationId: 'o',
        meetingId: 'm',
        recordingId: 'r',
        status: 'completed',
        at,
      }),
    ).toBe(true);
  });
});
