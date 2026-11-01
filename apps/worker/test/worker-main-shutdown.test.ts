/**
 * Exercises the real main() shutdown path: with calendar sync enabled, SIGTERM must close the calendar-sync worker
 * and queue (waiting for an in-flight sweep) before process.exit. Redis/BullMQ and the media worker are faked.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const closed: string[] = [];
const upserts: string[] = [];
vi.mock('@meetops/queue', () => ({
  createQueue: (name: string) => ({
    upsertJobScheduler: vi.fn(async (id: string) => void upserts.push(id)),
    close: vi.fn(async () => void closed.push(`queue:${name}`)),
  }),
  createWorker: (name: string) => ({
    close: vi.fn(async () => void closed.push(`worker:${name}`)),
  }),
}));
vi.mock('../src/media/index.js', () => ({
  startMediaWorker: () => ({ close: vi.fn(async () => void closed.push('media')) }),
}));

const ENV = {
  CALENDAR_SYNC_ENABLED: 'true',
  INTEGRATIONS_TOKEN_KEK: Buffer.alloc(32).toString('base64'), // fixture, not a real key
  IP_RETENTION_ENABLED: 'false',
};

afterEach(() => {
  for (const k of Object.keys(ENV)) delete process.env[k];
  vi.restoreAllMocks();
});

describe('worker main() shutdown', () => {
  it('SIGTERM closes calendar-sync (worker, then queue) before exiting', async () => {
    Object.assign(process.env, ENV);
    const handlers: Record<string, () => void> = {};
    vi.spyOn(process, 'on').mockImplementation(((ev: string, h: () => void) => {
      handlers[ev] = h;
      return process;
    }) as never);
    const exited = new Promise<number | undefined>((resolve) => {
      vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
        resolve(code);
      }) as never);
    });
    const { main } = await import('../src/index.js');
    await main();
    expect(upserts).toEqual(['calendar.sync.sweep']);
    expect(handlers.SIGTERM).toBeTypeOf('function');
    handlers.SIGTERM!();
    await expect(exited).resolves.toBe(0);
    expect(closed).toContain('worker:calendar.sync');
    expect(closed).toContain('queue:calendar.sync');
    expect(closed.indexOf('worker:calendar.sync')).toBeLessThan(
      closed.indexOf('queue:calendar.sync'),
    );
  });
});
