import { describe, expect, it, vi } from 'vitest';
import { CURRENT_CONSENT_VERSION } from '@meetops/contracts/types';
import type { StoredChunk, StoredSession } from '../src/lib/chunk-store.js';
import {
  directUploadInput,
  drainDirectUploads,
  isDirectUploadable,
  type DirectDrainStore,
} from '../src/lib/direct-drain.js';
import type { DirectUploadInput } from '../src/lib/upload-direct.js';

const MEETING = '00000000-0000-4000-8000-0000000000a1';
const consent = {
  consentVersion: CURRENT_CONSENT_VERSION,
  attestedAt: '2026-10-26T10:00:00.000Z',
  method: 'all_parties_consented' as const,
};

function session(id: string, over: Partial<StoredSession> = {}): StoredSession {
  return {
    sessionId: id,
    meta: {
      mimeType: 'audio/webm;codecs=opus',
      startedAt: '2026-10-26T10:00:00.000Z',
      source: 'tab',
      meetingId: MEETING,
      consent,
    },
    finalized: { chunkCount: 2, durationMs: 1000 },
    completed: true,
    ...over,
  };
}
const chunk = (sessionId: string, seq: number, text: string): StoredChunk => {
  const data = new TextEncoder().encode(text).buffer;
  return {
    sessionId,
    seq,
    data,
    size: data.byteLength,
    mimeType: 'audio/webm',
    createdAt: seq,
    uploaded: true,
  };
};

function fakeStore(
  sessions: StoredSession[],
  chunks: StoredChunk[],
): DirectDrainStore & { deleted: string[] } {
  const deleted: string[] = [];
  return {
    deleted,
    listSessions: async () => sessions.filter((s) => !deleted.includes(s.sessionId)),
    listChunks: async (id) => chunks.filter((c) => c.sessionId === id),
    deleteSession: async (id) => {
      deleted.push(id);
    },
  };
}

describe('direct-upload drain', () => {
  it('only uploads finished, clean sessions with consent', () => {
    expect(isDirectUploadable(session('a'))).toBe(true);
    const open = session('a');
    delete open.finalized;
    expect(isDirectUploadable(open)).toBe(false);
    expect(isDirectUploadable(session('a', { completed: false }))).toBe(false);
    expect(isDirectUploadable(session('a', { abortedReason: 'user_stopped' }))).toBe(false);
    expect(isDirectUploadable(session('a', { incomplete: { lostChunks: 1 } }))).toBe(false);
    const noConsent = session('a');
    delete (noConsent.meta as { consent?: unknown }).consent;
    expect(isDirectUploadable(noConsent)).toBe(false);
  });

  it('assembles chunks in seq order with the session consent and meeting', async () => {
    const input = directUploadInput(session('a'), [
      chunk('a', 1, 'world'),
      chunk('a', 0, 'hello '),
    ]);
    expect(await input.blob.text()).toBe('hello world');
    expect(input.blob.type).toBe('audio/webm;codecs=opus');
    expect(input.filename).toBe('recording-2026-10-26T10-00-00-000Z.webm');
    expect(input.meetingId).toBe(MEETING);
    expect(input.consent).toEqual(consent);
  });

  it('deletes local data only after a successful upload and keeps failures for retry', async () => {
    const store = fakeStore(
      [session('ok'), session('bad'), session('marked'), session('open', { completed: false })],
      [chunk('ok', 0, 'x'), chunk('bad', 0, 'y'), chunk('marked', 0, 'z'), chunk('open', 0, 'w')],
    );
    const upload = vi.fn(async (input: DirectUploadInput) => {
      if ((await input.blob.text()) === 'y') throw new Error('500');
      return { fileObjectId: 'f', scanStatus: 'pending' };
    });
    const res = await drainDirectUploads(
      store,
      { upload },
      { isMarked: async (id) => id === 'marked' },
    );
    expect(res).toEqual({ uploaded: ['ok'], failed: ['bad'] });
    expect(store.deleted).toEqual(['ok']);
    expect(upload).toHaveBeenCalledTimes(2);
  });
});
