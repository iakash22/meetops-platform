/**
 * startMediaWorker wiring of the #92 persistence steps (chunk FileObject rows + recordings.chunk_count), run through
 * the real @meetops/database repositories over a fake Prisma client that records every statement together with the
 * organization context (app.current_organization_id) active in its transaction, and emulates forced RLS.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { StorageNotFoundError } from '@meetops/storage';
import {
  chunkFileObjectId,
  createMediaPersistence,
  createPersistedChunkAudioResolver,
  processRecording,
  type MediaJobPayload,
} from '../src/media/index.js';
import { makeWorkerParts } from './media-worker-harness.js';

/** ADR-010 GUC read by every RLS policy (packages/database tenant.ts). */
const ORGANIZATION_CONTEXT_SETTING = 'app.current_organization_id';
const ORG = '11111111-1111-4111-8111-111111111111';
const OTHER_ORG = '44444444-4444-4444-8444-444444444444';
const MEET = '22222222-2222-4222-8222-222222222222';
const REC = '33333333-3333-4333-8333-333333333333';
const payload: MediaJobPayload = {
  jobVersion: 1,
  kind: 'process_recording',
  organizationId: ORG,
  meetingId: MEET,
  recordingId: REC,
  sourceExt: 'webm',
};

type Stmt = {
  sql: string;
  values: unknown[];
  inTransaction: boolean;
  organizationId: string | null;
};
type FileObjectRow = {
  id: string;
  organizationId: string;
  meetingId: string;
  key: string;
  kind: string;
  bucket: string;
  provider: string;
  sizeBytes: number;
  sha256: string | null;
  chunkIndex: number;
  startSeconds: number;
  durationSeconds: number;
};

/** Fake Prisma client: statements only exist on transaction clients; RLS is emulated from the transaction's GUC. */
function fakePrisma(recordings: Array<{ id: string; organizationId: string; meetingId: string }>) {
  const statements: Stmt[] = [];
  const fileObjects = new Map<string, FileObjectRow>();
  const recs = new Map(recordings.map((r) => [r.id, { ...r, chunkCount: null as number | null }]));
  let transactions = 0;
  const client = {
    async $transaction<R>(fn: (tx: never) => Promise<R>): Promise<R> {
      transactions++;
      let org: string | null = null;
      const pending = new Map<string, FileObjectRow>();
      const record = (strings: TemplateStringsArray, values: unknown[]) => {
        const sql = strings.join('$').replace(/\s+/g, ' ').trim();
        statements.push({ sql, values, inTransaction: true, organizationId: org });
        return sql;
      };
      const tx = {
        $executeRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
          const sql = record(strings, values);
          if (sql.startsWith('SELECT set_config(')) {
            if (values[0] === ORGANIZATION_CONTEXT_SETTING) org = values[1] as string;
            return 1;
          }
          if (sql.startsWith('UPDATE "recordings" SET "chunk_count"')) {
            const [chunkCount, orgId, recordingId, meetingId] = values as [
              number,
              string,
              string,
              string,
            ];
            const r = recs.get(recordingId);
            // USING (org_id = current org): rows of other organizations are invisible.
            if (
              !r ||
              r.organizationId !== org ||
              r.organizationId !== orgId ||
              r.meetingId !== meetingId
            )
              return 0;
            r.chunkCount = chunkCount;
            return 1;
          }
          throw new Error(`unexpected statement: ${sql}`);
        },
        $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
          const sql = record(strings, values);
          if (!sql.startsWith('INSERT INTO "file_objects"'))
            throw new Error(`unexpected query: ${sql}`);
          const [
            id,
            orgId,
            meetingId,
            provider,
            bucket,
            key,
            ,
            sizeBytes,
            sha256,
            chunkIndex,
            startSeconds,
            durationSeconds,
          ] = values as [
            string,
            string,
            string,
            string,
            string,
            string,
            string,
            number,
            string | null,
            number,
            number,
            number,
          ];
          // WITH CHECK (org_id = current org).
          if (orgId !== org)
            throw Object.assign(new Error('new row violates row-level security policy'), {
              code: '42501',
            });
          const existing = fileObjects.get(id) ?? pending.get(id);
          if (existing && (existing.organizationId !== orgId || existing.key !== key)) return [];
          pending.set(id, {
            id,
            organizationId: orgId,
            meetingId,
            key,
            kind: 'chunk',
            bucket,
            provider,
            sizeBytes,
            sha256,
            chunkIndex,
            startSeconds,
            durationSeconds,
          });
          return [{ id }];
        },
        fileObject: {
          findFirst: async ({ where }: { where: { id: string; organizationId: string } }) => {
            statements.push({
              sql: 'SELECT file_objects',
              values: [where.id],
              inTransaction: true,
              organizationId: org,
            });
            const row = fileObjects.get(where.id);
            if (!row || row.organizationId !== org || row.organizationId !== where.organizationId)
              return null;
            return {
              id: row.id,
              organizationId: row.organizationId,
              meetingId: row.meetingId,
              kind: row.kind,
              key: row.key,
              mimeType: 'audio/wav',
              sizeBytes: BigInt(row.sizeBytes),
              chunkIndex: row.chunkIndex,
            };
          },
        },
      };
      const out = await fn(tx as never); // a throw rolls the transaction back: pending rows are dropped
      for (const [k, v] of pending) fileObjects.set(k, v);
      return out;
    },
  };
  return { client, statements, fileObjects, recordings: recs, transactions: () => transactions };
}

const isWrite = (s: Stmt) => /^(INSERT|UPDATE|DELETE)\b/.test(s.sql);

const root = mkdtempSync(path.join(tmpdir(), 'worker-persist-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let tmpRoot: string;
beforeEach(() => {
  tmpRoot = mkdtempSync(path.join(root, 't-'));
});

describe('startMediaWorker persistence wiring (#92)', () => {
  it('buildMediaProcessorDeps wires chunk rows, chunk_count, waveform and realtime', () => {
    const db = fakePrisma([]);
    const persistence = createMediaPersistence({ client: db.client, bucket: 'meetops-media' });
    const { built } = makeWorkerParts(tmpRoot, persistence, payload);
    expect(built.chunkFileObjects).toBe(persistence.chunkFileObjects);
    expect(built.recordings).toBe(persistence.recordings);
    expect(built.waveform).toBeDefined();
    expect(Object.keys(built.realtime)).toContain('processingStatus');
  });

  it('writes chunk FileObject records for every chunk', async () => {
    const db = fakePrisma([{ id: REC, organizationId: ORG, meetingId: MEET }]);
    const persistence = createMediaPersistence({
      client: db.client,
      bucket: 'meetops-media',
      provider: 'minio',
    });
    const { deps, stored } = makeWorkerParts(tmpRoot, persistence, payload);
    await processRecording(payload, deps);
    const rows = [...db.fileObjects.values()].sort((a, b) => a.chunkIndex - b.chunkIndex);
    expect(rows.map((r) => r.id)).toEqual([0, 1, 2].map((i) => chunkFileObjectId(REC, i)));
    for (const r of rows) {
      expect(r).toMatchObject({
        organizationId: ORG,
        meetingId: MEET,
        kind: 'chunk',
        bucket: 'meetops-media',
        provider: 'minio',
      });
      expect(r.key).toBe(
        `organizations/${ORG}/meetings/${MEET}/processed/${REC}/chunks/0000${r.chunkIndex}.wav`,
      );
      expect(r.sizeBytes).toBe(stored.get(r.key)!.length);
      expect(r.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(rows.map((r) => [r.startSeconds, r.durationSeconds])).toEqual([
      [0, 10],
      [10, 10],
      [20, 5],
    ]);
    // A retry upserts the same ids: still three rows.
    await processRecording(payload, deps);
    expect(db.fileObjects.size).toBe(3);
  });

  it('sets recordings.chunk_count before any transcription job is enqueued', async () => {
    const db = fakePrisma([{ id: REC, organizationId: ORG, meetingId: MEET }]);
    const persistence = createMediaPersistence({ client: db.client, bucket: 'meetops-media' });
    const { deps, jobs } = makeWorkerParts(tmpRoot, persistence, payload);
    let countAtFirstJob: number | null | undefined;
    const queue = deps.transcriptionQueue;
    deps.transcriptionQueue = {
      add: async (n, d, o) => (
        (countAtFirstJob ??= db.recordings.get(REC)!.chunkCount),
        queue.add(n, d, o)
      ),
    };
    await processRecording(payload, deps);
    expect(db.recordings.get(REC)!.chunkCount).toBe(3);
    expect(countAtFirstJob).toBe(3);
    expect(jobs.size).toBe(3);
  });

  it('writes nothing outside the job organization context', async () => {
    const db = fakePrisma([{ id: REC, organizationId: ORG, meetingId: MEET }]);
    const persistence = createMediaPersistence({ client: db.client, bucket: 'meetops-media' });
    const { deps } = makeWorkerParts(tmpRoot, persistence, payload);
    await processRecording(payload, deps);
    const writes = db.statements.filter(isWrite);
    expect(writes.length).toBe(4); // 3 chunk upserts + 1 chunk_count update
    for (const w of writes) expect(w).toMatchObject({ inTransaction: true, organizationId: ORG });
    // Each transaction sets the context first (current + legacy GUC) and only then runs its statement(s).
    expect(db.transactions()).toBe(2);
    const sets = db.statements.filter((s) => s.sql.startsWith('SELECT set_config('));
    expect(sets.map((s) => s.values.slice(0, 2))).toEqual([
      [ORGANIZATION_CONTEXT_SETTING, ORG],
      ['app.current_org_id', ORG],
      [ORGANIZATION_CONTEXT_SETTING, ORG],
      ['app.current_org_id', ORG],
    ]);
    // The root client has no raw query surface at all: a write outside $transaction cannot even be issued.
    expect('$executeRaw' in db.client).toBe(false);
  });

  it('a job for a recording of another organization persists nothing and enqueues nothing', async () => {
    const db = fakePrisma([{ id: REC, organizationId: OTHER_ORG, meetingId: MEET }]);
    const persistence = createMediaPersistence({ client: db.client, bucket: 'meetops-media' });
    const { deps, jobs } = makeWorkerParts(tmpRoot, persistence, payload);
    await expect(processRecording(payload, deps)).rejects.toMatchObject({
      errorCode: 'chunk_count_persist_failed',
    });
    expect(db.recordings.get(REC)!.chunkCount).toBeNull();
    expect(jobs.size).toBe(0);
    for (const w of db.statements.filter(isWrite)) expect(w.organizationId).toBe(ORG);
  });

  it('keeps the #88 waveform step and #90 realtime rooms', async () => {
    const db = fakePrisma([{ id: REC, organizationId: ORG, meetingId: MEET }]);
    const persistence = createMediaPersistence({ client: db.client, bucket: 'meetops-media' });
    const { deps, events, stored } = makeWorkerParts(tmpRoot, persistence, payload);
    const res = await processRecording(payload, deps);
    expect(res.waveform).toMatchObject({ bins: 1 });
    expect(stored.has(`organizations/${ORG}/meetings/${MEET}/processed/${REC}/waveform.json`)).toBe(
      true,
    );
    const rooms = new Set(events.flatMap((e) => e.rooms));
    expect([...rooms].sort()).toEqual([
      `organizations:${ORG}`,
      `organizations:${ORG}:meetings:${MEET}`,
    ]);
    expect(events.some((e) => e.event === 'processing:status')).toBe(true);
  });

  it('the persisted chunk rows resolve to audio only for their organization', async () => {
    const db = fakePrisma([{ id: REC, organizationId: ORG, meetingId: MEET }]);
    const persistence = createMediaPersistence({ client: db.client, bucket: 'meetops-media' });
    const { deps, stored, storage } = makeWorkerParts(tmpRoot, persistence, payload);
    await processRecording(payload, deps);
    const resolver = createPersistedChunkAudioResolver(storage, persistence);
    const id = chunkFileObjectId(REC, 1);
    const r = await resolver.bytes({ organizationId: ORG, fileObjectId: id });
    expect(
      Buffer.from(r.bytes).equals(
        stored.get(`organizations/${ORG}/meetings/${MEET}/processed/${REC}/chunks/00001.wav`)!,
      ),
    ).toBe(true);
    await expect(
      resolver.bytes({ organizationId: OTHER_ORG, fileObjectId: id }),
    ).rejects.toBeInstanceOf(StorageNotFoundError);
    for (const s of db.statements.filter((x) => x.sql === 'SELECT file_objects'))
      expect(s.inTransaction).toBe(true);
  });
});
