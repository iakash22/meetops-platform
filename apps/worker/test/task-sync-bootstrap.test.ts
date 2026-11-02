import { describe, expect, it, vi } from 'vitest';
import { TASK_SYNC_QUEUE } from '@meetops/contracts';
import {
  loadTaskSyncEnv,
  registerTaskSyncWorker,
  TaskSyncEnvError,
} from '../src/integrations/task-sync-bootstrap.js';
import type { TaskSyncDeps } from '../src/integrations/task-sync.js';

const KEK = Buffer.alloc(32, 7).toString('base64');
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

describe('loadTaskSyncEnv', () => {
  it('is off by default', () => {
    expect(loadTaskSyncEnv({}).enabled).toBe(false);
  });
  it('fails closed without a KEK when enabled', () => {
    expect(() => loadTaskSyncEnv({ TASK_SYNC_ENABLED: 'true' })).toThrow(TaskSyncEnvError);
  });
  it('rejects a non-boolean flag without echoing it', () => {
    try {
      loadTaskSyncEnv({ TASK_SYNC_ENABLED: 'sekrit-value' });
      expect.unreachable();
    } catch (e) {
      expect((e as Error).message).not.toContain('sekrit');
    }
  });
  it('accepts a 32-byte KEK', () => {
    const env = loadTaskSyncEnv({ TASK_SYNC_ENABLED: 'true', INTEGRATIONS_TOKEN_KEK: KEK });
    expect(env.enabled).toBe(true);
    expect(env.kek?.length).toBe(32);
  });
});

describe('registerTaskSyncWorker', () => {
  it('does not register when disabled', async () => {
    const createWorker = vi.fn();
    const r = await registerTaskSyncWorker({ env: { enabled: false }, log, createWorker });
    expect(r.registered).toBe(false);
    expect(createWorker).not.toHaveBeenCalled();
  });
  it('consumes the task-sync queue and drops malformed payloads', async () => {
    let processor: ((job: { data: unknown }) => Promise<unknown>) | undefined;
    const close = vi.fn(async () => undefined);
    const createWorker = vi.fn((name: string, p: (job: { data: unknown }) => Promise<unknown>) => {
      expect(name).toBe(TASK_SYNC_QUEUE);
      processor = p;
      return { close };
    });
    const r = await registerTaskSyncWorker({
      env: { enabled: true, kek: Buffer.alloc(32) },
      log,
      createWorker,
      buildDeps: () => ({}) as unknown as TaskSyncDeps,
    });
    expect(r.registered).toBe(true);
    await expect(processor?.({ data: { organizationId: 'x', body: 'nope' } })).resolves.toBe(
      'skipped',
    );
    if (r.registered) await r.close();
    expect(close).toHaveBeenCalled();
  });
});
