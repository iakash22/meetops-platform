import { Readable } from 'node:stream';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import {
  LEGACY_ORG_KEY_PREFIX,
  S3StorageService,
  SESSION_CHUNK_PREFIX,
  StorageAccessError,
  assertKeyOwnedBy,
  buildObjectKey,
  loadStorageConfig,
  parseMeetingKey,
  type AuthorizeTarget,
  type MeetingObjectKind,
  type MeetingObjectRef
} from '../src/index.js';

const s3 = mockClient(S3Client);
const authorize = vi.fn<(t: AuthorizeTarget) => undefined>(() => undefined);
const svc = () =>
  new S3StorageService({
    config: loadStorageConfig({ STORAGE_BUCKET: 'b', STORAGE_ENDPOINT: 'http://localhost:9000', STORAGE_ACCESS_KEY_ID: 'a', STORAGE_SECRET_ACCESS_KEY: 's' }),
    client: new S3Client({ region: 'us-east-1', credentials: { accessKeyId: 'a', secretAccessKey: 's' } }),
    presign: vi.fn(async (_c: unknown, cmd: { input: { Key?: string } }) => `https://signed/${cmd.input.Key}`) as never,
    authorize
  });
beforeEach(() => {
  s3.reset();
  authorize.mockClear();
});

const LEGACY = 'org/o1/meetings/m1/recordings/r1.webm';
const CURRENT = 'organizations/o1/meetings/m1/recordings/r1.webm';

describe('legacy org/ prefix: readers accept, writers never emit', () => {
  it('writers (buildObjectKey) emit only organizations/ for every kind', () => {
    const kinds: Array<[MeetingObjectKind, Partial<MeetingObjectRef>]> = [
      ['recording', { ext: 'webm' }], ['normalized', {}], ['chunk', { index: 0 }], ['session_chunk', { index: 0 }],
      ['transcript', { ext: 'json' }], ['export', { ext: 'pdf' }], ['attachment', { ext: 'png' }]
    ];
    for (const [kind, extra] of kinds) {
      const key = buildObjectKey({ organizationId: 'o1', meetingId: 'm1', kind, objectId: 'x1', ...extra });
      const k = key.startsWith(SESSION_CHUNK_PREFIX) ? key.slice(SESSION_CHUNK_PREFIX.length) : key;
      expect(k.startsWith('organizations/o1/')).toBe(true);
      expect(k.startsWith(LEGACY_ORG_KEY_PREFIX)).toBe(false);
    }
  });
  it('putObject writes under organizations/ only', async () => {
    s3.on(PutObjectCommand).resolves({});
    await svc().putObject({ organizationId: 'o1', meetingId: 'm1', kind: 'recording', objectId: 'r1', ext: 'webm' }, Buffer.from('abc'), { mimeType: 'audio/webm', sizeBytes: 3 });
    expect(s3.commandCalls(PutObjectCommand)[0]!.args[0].input.Key).toBe(CURRENT);
  });
  it('assertKeyOwnedBy accepts the owner under both prefixes, incl. legacy session chunks', () => {
    for (const k of [LEGACY, CURRENT, `${SESSION_CHUNK_PREFIX}org/o1/meetings/m1/sessions/s1/00000.part`]) expect(() => assertKeyOwnedBy(k, 'o1', 'm1')).not.toThrow();
  });
  it('rejects other organizations, other meetings, traversal and unknown prefixes under both prefixes', () => {
    const bad: Array<[string, string, string?]> = [
      [LEGACY, 'o2'], [CURRENT, 'o2'], [LEGACY, 'o1', 'm2'], [CURRENT, 'o1', 'm2'],
      ['org/o1/../o2/meetings/m1/recordings/r1.webm', 'o1'], ['organizations/o1/meetings/m1/../../o2/x', 'o1'],
      ['orgs/o1/meetings/m1/recordings/r1.webm', 'o1'], ['organisation/o1/meetings/m1/x', 'o1'], ['o1/meetings/m1/x', 'o1'],
      ['org/o10/meetings/m1/x.webm', 'o1'], ['organizations/o1x/meetings/m1/x.webm', 'o1'], ['/org/o1/meetings/m1/x', 'o1']
    ];
    for (const [k, org, meeting] of bad) expect(() => assertKeyOwnedBy(k, org, meeting)).toThrow(StorageAccessError);
    expect(parseMeetingKey('orgs/o1/meetings/m1/x')).toBeNull();
  });
  it('stored-key reads use the stored legacy key as-is (no rebuild) and pass it to authorize', async () => {
    s3.on(GetObjectCommand).resolves({ Body: Readable.from([Buffer.from('abc')]) as never, ContentLength: 3 });
    s3.on(HeadObjectCommand).resolves({ ContentLength: 3 });
    const s = svc();
    const stored = { organizationId: 'o1', meetingId: 'm1', key: LEGACY };
    await s.getObjectByKey(stored);
    await s.headObjectByKey(stored);
    const url = await s.getPresignedDownloadUrlByKey(stored, { ttlSeconds: 60 });
    expect(s3.commandCalls(GetObjectCommand)[0]!.args[0].input.Key).toBe(LEGACY);
    expect(s3.commandCalls(HeadObjectCommand)[0]!.args[0].input.Key).toBe(LEGACY);
    expect(url.url).toBe(`https://signed/${LEGACY}`);
    expect(authorize).toHaveBeenCalledWith(stored);
  });
  it('stored-key reads reject cross-organization keys under both prefixes before any S3 call', async () => {
    const s = svc();
    for (const key of [LEGACY, CURRENT]) {
      await expect(s.getObjectByKey({ organizationId: 'o2', meetingId: 'm1', key })).rejects.toThrow(StorageAccessError);
      await expect(s.getPresignedDownloadUrlByKey({ organizationId: 'o2', meetingId: 'm1', key })).rejects.toThrow(StorageAccessError);
      await expect(s.headObjectByKey({ organizationId: 'o1', meetingId: 'm2', key })).rejects.toThrow(StorageAccessError);
    }
    expect(s3.calls()).toHaveLength(0);
    expect(authorize).not.toHaveBeenCalled();
  });
});
