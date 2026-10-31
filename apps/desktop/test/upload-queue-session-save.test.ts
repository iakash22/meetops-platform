import { describe, expect, it, vi } from 'vitest';

import {
  createMemoryChunkStore,
  createUploadQueue,
  type NewRecording,
  type RecordingUploadApi,
} from '@/features/recording/upload-queue';

const USER = '00000000-0000-4000-8000-000000000002';
const ORG = '00000000-0000-4000-8000-000000000001';

function api(): RecordingUploadApi {
  let n = 0;
  return {
    init: vi.fn(() => Promise.resolve({ sessionId: `s${++n}` })),
    chunkUrl: vi.fn((_s: string, body: { seq: number }) =>
      Promise.resolve({
        upload: {
          method: 'PUT' as const,
          url: 'https://u.test/x',
          headers: {},
          expiresAt: '2030-01-01T00:00:00.000Z',
        },
        seq: body.seq,
      }),
    ),
    put: vi.fn(() => Promise.resolve()),
    complete: vi.fn(() => Promise.resolve()),
    abort: vi.fn(() => Promise.resolve()),
  };
}

const rec = (): NewRecording =>
  ({
    id: 'r1',
    userId: USER,
    organizationId: ORG,
    meetingId: 'm1',
    meetingTitle: 'Fixture',
    mimeType: 'audio/webm;codecs=opus',
    startedAt: '2026-10-31T00:00:00.000Z',
    durationMs: 1000,
    chunks: [{ seq: 0, size: 1, sha256: 'a'.repeat(64) }],
    consent: {},
  }) as unknown as NewRecording;

describe('upload queue: server session vs local save', () => {
  it('aborts the new server session and uploads nothing when saving it locally fails', async () => {
    const a = api();
    const mem = createMemoryChunkStore();
    await mem.put('r1', 0, new Uint8Array([1]));
    let failSaves = false;
    const chunks = {
      ...mem,
      saveMeta: (id: string, m: string) =>
        failSaves ? Promise.reject(new Error('disk full')) : mem.saveMeta(id, m),
    };
    const q = createUploadQueue(a, chunks, {
      isOnline: () => true,
      identity: () => ({ userId: USER, organizationId: ORG }),
    });
    q.enqueue(rec());
    failSaves = true;
    await q.process();
    expect(a.abort).toHaveBeenCalledWith('s1', 'error');
    expect(a.chunkUrl).not.toHaveBeenCalled();
    expect(q.items()[0]).toMatchObject({ sessionId: null, state: 'pending' });

    failSaves = false;
    await q.retry('r1');
    expect(a.init).toHaveBeenCalledTimes(2);
    expect(a.complete).toHaveBeenCalledWith('s2', expect.anything());
    expect(a.abort).toHaveBeenCalledTimes(1);
  });
});
