import { describe, expect, it, vi } from 'vitest';
import { UnrecoverableError } from 'bullmq';
import { dispatchMediaJob } from '../src/media/worker.js';
import type { MediaProcessorDeps } from '../src/media/processor.js';
import type { SessionAssemblyDeps } from '../src/media/assemble-session.js';

const job = (name: string, data: unknown = {}) => ({
  name,
  data,
  id: '1',
  attemptsMade: 0,
  opts: { attempts: 1 },
});
const silent = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

describe('dispatchMediaJob', () => {
  it('fails process_upload and unknown names without retry', async () => {
    const d = {} as MediaProcessorDeps;
    const a = {} as SessionAssemblyDeps;
    await expect(dispatchMediaJob(job('process_upload'), d, a)).rejects.toBeInstanceOf(
      UnrecoverableError,
    );
    await expect(dispatchMediaJob(job('nope'), d, a)).rejects.toBeInstanceOf(UnrecoverableError);
  });

  it('routes assemble_recording_session to the assembler (invalid payload rejected)', async () => {
    const recordProcessingFailed = vi.fn(async () => {});
    const a = {
      store: { loadSession: vi.fn(), recordAssembled: vi.fn(), recordProcessingFailed },
      logger: silent,
    } as unknown as SessionAssemblyDeps;
    await expect(
      dispatchMediaJob(
        job('assemble_recording_session', { kind: 'x' }),
        {} as MediaProcessorDeps,
        a,
      ),
    ).rejects.toMatchObject({
      code: 'invalid_job',
    });
  });
});
