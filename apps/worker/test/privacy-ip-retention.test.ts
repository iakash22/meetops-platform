import { describe, expect, it, vi } from 'vitest';
import {
  IP_RETENTION_CRON,
  IP_RETENTION_SCHEDULER_ID,
  runIpRetention,
  scheduleIpRetention,
} from '../src/privacy/index.js';

const log = () => ({ info: vi.fn(), warn: vi.fn() });

describe('ip retention job', () => {
  it('logs counts only and returns the result', async () => {
    const l = log();
    const res = await runIpRetention({
      redact: async () => ({
        sessionsRedacted: 2,
        auditEventsRedacted: 5,
        passwordResetsRedacted: 1,
      }),
      log: l,
    });
    expect(res).toEqual({ sessionsRedacted: 2, auditEventsRedacted: 5, passwordResetsRedacted: 1 });
    expect(l.info).toHaveBeenCalledWith(
      { sessionsRedacted: 2, auditEventsRedacted: 5, passwordResetsRedacted: 1 },
      expect.any(String),
    );
  });
  it('rethrows so BullMQ retries, without logging the error message', async () => {
    const l = log();
    await expect(
      runIpRetention({ redact: async () => Promise.reject(new TypeError('203.0.113.9')), log: l }),
    ).rejects.toThrow(TypeError);
    expect(JSON.stringify(l.warn.mock.calls)).not.toContain('203.0.113.9');
  });
  it('upserts one daily UTC scheduler', async () => {
    const upsertJobScheduler = vi.fn(async () => undefined);
    await scheduleIpRetention({ upsertJobScheduler });
    expect(upsertJobScheduler).toHaveBeenCalledWith(
      IP_RETENTION_SCHEDULER_ID,
      { pattern: IP_RETENTION_CRON, tz: 'UTC' },
      expect.objectContaining({ name: 'redact' }),
    );
  });
});
