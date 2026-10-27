import { describe, expect, it } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import {
  AssembleRecordingSessionJobPayload,
  MEDIA_QUEUE,
  UploadScanJobPayload,
} from '@meetops/contracts';
import {
  BullMqMediaJobQueue,
  type MediaQueueProducer,
} from '../src/modules/media/infrastructure/bullmq-job-queue.js';
import {
  mediaJobId,
  sessionChunkKey,
  sessionSourceExt,
  type MediaProcessingJob,
} from '../src/modules/media/domain/ports.js';

const ORG = '00000000-0000-4000-8000-000000000001';
const MEETING = '00000000-0000-4000-8000-000000000002';
const SESSION = '00000000-0000-4000-8000-000000000003';
const CONSENT = '00000000-0000-4000-8000-000000000004';

const upload: MediaProcessingJob = {
  jobVersion: 1,
  kind: 'process_upload',
  organizationId: ORG,
  uploadId: SESSION,
  consentAttestationId: CONSENT,
};
const assemble: MediaProcessingJob = {
  jobVersion: 1,
  kind: 'assemble_recording_session',
  organizationId: ORG,
  meetingId: MEETING,
  sessionId: SESSION,
  consentAttestationId: CONSENT,
  sourceExt: 'webm',
};

function fakeQueue(name: string = MEDIA_QUEUE) {
  const added: { name: string; data: MediaProcessingJob; opts: { jobId: string } }[] = [];
  const q: MediaQueueProducer = {
    name,
    add: async (n, data, opts) => {
      added.push({ name: n, data, opts });
    },
  };
  return { q, added };
}

describe('BullMqMediaJobQueue', () => {
  it('adds contract-valid payloads named by kind with deterministic job ids', async () => {
    const { q, added } = fakeQueue();
    const p = new BullMqMediaJobQueue(q);
    await p.enqueue(upload);
    await p.enqueue(assemble);
    expect(added.map((a) => [a.name, a.opts.jobId])).toEqual([
      ['process_upload', `process_upload:${SESSION}`],
      ['assemble_recording_session', `assemble_recording_session:${SESSION}`],
    ]);
    expect(Value.Check(UploadScanJobPayload, added[0]!.data)).toBe(true);
    expect(Value.Check(AssembleRecordingSessionJobPayload, added[1]!.data)).toBe(true);
    expect(mediaJobId(assemble)).toBe(added[1]!.opts.jobId);
  });

  it('refuses a queue other than MEDIA_QUEUE', () => {
    expect(() => new BullMqMediaJobQueue(fakeQueue('other').q)).toThrow(/media/);
  });
});

describe('session chunk keys and source ext', () => {
  it('matches the @meetops/storage session_chunk layout', () => {
    expect(sessionChunkKey(ORG, MEETING, SESSION, 7)).toBe(
      `tmp/session-chunks/organizations/${ORG}/meetings/${MEETING}/sessions/${SESSION}/00007.part`,
    );
  });
  it('maps session MIME types to worker source exts', () => {
    expect(sessionSourceExt('video/webm;codecs=vp9,opus')).toBe('webm');
    expect(sessionSourceExt('audio/mp4')).toBe('m4a');
    expect(sessionSourceExt('application/pdf')).toBeNull();
  });
});
