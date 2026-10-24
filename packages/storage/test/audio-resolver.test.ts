import { Readable } from 'node:stream';
import { describe, it, expect, vi } from 'vitest';
import {
  StorageAccessError,
  StorageNotFoundError,
  StorageValidationError,
  buildObjectKey,
  createChunkAudioResolver,
  type ChunkFileObjectRecord,
  type MeetingObjectRef,
  type StoredKeyRef
} from '../src/index.js';

const ORG = 'org-a';
const MEET = 'meet-1';
const REC = 'rec-1';
const FID = 'f0f0f0f0-0000-5000-8000-000000000001';
const chunkRef: MeetingObjectRef = { organizationId: ORG, meetingId: MEET, kind: 'chunk', objectId: REC, index: 2 };
const KEY = buildObjectKey(chunkRef);
const row = (o: Partial<ChunkFileObjectRecord> = {}): ChunkFileObjectRecord => ({
  id: FID, organizationId: ORG, meetingId: MEET, kind: 'chunk', key: KEY, mimeType: 'audio/wav', sizeBytes: 3, chunkIndex: 2, ...o
});

function setup(r: ChunkFileObjectRecord | null = row(), body = 'abc') {
  const getObject = vi.fn(async (ref: StoredKeyRef) => ({ ref, body: Readable.from([Buffer.from(body)]), info: { sizeBytes: Buffer.byteLength(body) } }));
  const getPresignedDownloadUrl = vi.fn(async (ref: StoredKeyRef, o?: { ttlSeconds?: number }) => ({
    ref,
    url: 'https://signed.example/x', method: 'GET' as const, expiresAt: new Date(Date.now() + (o?.ttlSeconds ?? 0) * 1000)
  }));
  const findFileObject = vi.fn(async () => r);
  const resolver = createChunkAudioResolver({ storage: { getObjectByKey: getObject, getPresignedDownloadUrlByKey: getPresignedDownloadUrl }, lookup: { findFileObject }, maxBytes: 10 });
  return { resolver, getObject, getPresignedDownloadUrl, findFileObject };
}
const q = { organizationId: ORG, fileObjectId: FID };

describe('createChunkAudioResolver', () => {
  it('maps chunkFileObjectId -> FileObject row -> server-derived chunk ref and streams it', async () => {
    const { resolver, getObject, findFileObject } = setup();
    const s = await resolver.stream(q);
    expect(findFileObject).toHaveBeenCalledWith(q);
    expect(getObject.mock.calls[0]![0]).toEqual({ organizationId: ORG, meetingId: MEET, key: KEY });
    expect(s).toMatchObject({ kind: 'stream', mimeType: 'audio/wav', sizeBytes: 3 });
    expect(KEY).toBe('organizations/org-a/meetings/meet-1/processed/rec-1/chunks/00002.wav');
  });
  it('returns a short-lived presigned GET (default 120 s, max 300 s)', async () => {
    const { resolver, getPresignedDownloadUrl } = setup();
    await expect(resolver.url(q)).resolves.toMatchObject({ kind: 'url', mimeType: 'audio/wav', url: { method: 'GET' } });
    expect(getPresignedDownloadUrl.mock.calls[0]![1]).toEqual({ ttlSeconds: 120 });
    await expect(resolver.url(q, { ttlSeconds: 301 })).rejects.toThrow(StorageValidationError);
  });
  it('bytes() matches the ai-core AudioResolver shape', async () => {
    const { resolver } = setup();
    const r = await resolver.bytes(q);
    expect(Buffer.from(r.bytes).toString()).toBe('abc');
    expect(r.mimeType).toBe('audio/wav');
  });
  it('rejects a row from another organization', async () => {
    const { resolver, getObject } = setup(row({ organizationId: 'org-b' }));
    await expect(resolver.stream(q)).rejects.toThrow(StorageAccessError);
    expect(getObject).not.toHaveBeenCalled();
  });
  it('reads a legacy org/ chunk key as stored, never rebuilding it', async () => {
    const legacy = `org/${ORG}/meetings/${MEET}/processed/${REC}/chunks/00002.wav`;
    const { resolver, getObject, getPresignedDownloadUrl } = setup(row({ key: legacy }));
    await resolver.stream(q);
    await resolver.url(q);
    expect(getObject.mock.calls[0]![0]).toEqual({ organizationId: ORG, meetingId: MEET, key: legacy });
    expect(getPresignedDownloadUrl.mock.calls[0]![0].key).toBe(legacy);
  });
  it('rejects keys not owned by organizationId/meetingId or not exactly a chunk key', async () => {
    const bad = [
      buildObjectKey({ ...chunkRef, organizationId: 'org-b' }),
      `org/org-b/meetings/${MEET}/processed/${REC}/chunks/00002.wav`,
      `org/${ORG}/meetings/${MEET}/processed/${REC}/chunks/2.wav`,
      `bucket/${ORG}/meetings/${MEET}/processed/${REC}/chunks/00002.wav`,
      buildObjectKey({ organizationId: ORG, meetingId: MEET, kind: 'normalized', objectId: REC }),
      buildObjectKey({ ...chunkRef, meetingId: 'meet-2' }),
      `organizations/${ORG}/meetings/${MEET}/processed/${REC}/chunks/../../x.wav`,
      `tmp/session-chunks/organizations/${ORG}/meetings/${MEET}/sessions/s1/00000.part`
    ];
    for (const key of bad) {
      const { resolver, getObject, getPresignedDownloadUrl } = setup(row({ key }));
      await expect(resolver.stream(q)).rejects.toThrow(StorageAccessError);
      await expect(resolver.url(q)).rejects.toThrow(StorageAccessError);
      expect(getObject).not.toHaveBeenCalled();
      expect(getPresignedDownloadUrl).not.toHaveBeenCalled();
    }
  });
  it('rejects non-chunk kinds, mismatched id or chunkIndex, and missing rows', async () => {
    await expect(setup(row({ kind: 'raw' })).resolver.stream(q)).rejects.toThrow(StorageAccessError);
    await expect(setup(row({ id: 'other' })).resolver.stream(q)).rejects.toThrow(StorageAccessError);
    await expect(setup(row({ chunkIndex: 3 })).resolver.stream(q)).rejects.toThrow(StorageAccessError);
    await expect(setup(row({ meetingId: null })).resolver.stream(q)).rejects.toThrow(StorageAccessError);
    await expect(setup(null).resolver.stream(q)).rejects.toThrow(StorageNotFoundError);
    await expect(setup().resolver.stream({ organizationId: '../x', fileObjectId: FID })).rejects.toThrow(StorageValidationError);
  });
  it('enforces the size cap from the row and the stored object', async () => {
    await expect(setup(row({ sizeBytes: 11 })).resolver.stream(q)).rejects.toThrow(/size limit/);
    await expect(setup(row({ sizeBytes: null }), 'x'.repeat(11)).resolver.bytes(q)).rejects.toThrow(/size limit/);
  });
  it('error messages never echo the key', async () => {
    const { resolver } = setup(row({ organizationId: 'org-b' }));
    const err = await resolver.stream(q).catch((e: Error) => e);
    expect(String((err as Error).message)).not.toContain('organizations/');
  });
});
