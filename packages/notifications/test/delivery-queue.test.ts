import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_NOTIFICATION_JOB_OPTIONS,
  InvalidNotificationJobError,
  NOTIFICATION_DELIVERY_JOB_NAME,
  createNotificationDeliveryProcessor,
  createNotificationDeliveryProducer,
  loadEmailConfig,
  type NotificationDeliveryHandler,
  type NotificationDeliveryJobPayload,
} from '../src/index.js';

const ID = '00000000-0000-4000-8000-000000000001';
const ORG = '00000000-0000-4000-8000-0000000000a1';
const job: NotificationDeliveryJobPayload = {
  jobVersion: 1,
  kind: 'deliver_notification',
  organizationId: ORG,
  userId: ID,
  notificationId: ID,
  channel: 'web_push',
  deliveryKey: `${ID}:web_push`,
};

describe('notification delivery producer', () => {
  it('enqueues with jobId = deliveryKey and bounded retention', async () => {
    const add = vi.fn(async (_n: string, _d: unknown, o: { jobId: string }) => ({ id: o.jobId }));
    const p = createNotificationDeliveryProducer({ add, close: async () => {} } as never);
    expect(await p.enqueue(job)).toBe(job.deliveryKey);
    expect(add).toHaveBeenCalledWith(NOTIFICATION_DELIVERY_JOB_NAME, job, { ...DEFAULT_NOTIFICATION_JOB_OPTIONS, jobId: job.deliveryKey });
  });

  it('refuses a job without an organization context', async () => {
    const add = vi.fn();
    const p = createNotificationDeliveryProducer({ add, close: async () => {} });
    const noOrg: Partial<typeof job> = { ...job };
    delete noOrg.organizationId;
    await expect(p.enqueue(noOrg as never)).rejects.toThrow(InvalidNotificationJobError);
    expect(add).not.toHaveBeenCalled();
  });
});

describe('notification delivery processor', () => {
  const handler = (deliver: NotificationDeliveryHandler['deliver']) => {
    const orgs: string[] = [];
    const records: unknown[] = [];
    const h: NotificationDeliveryHandler = {
      runInOrganization: async (o, fn) => {
        orgs.push(o);
        return fn();
      },
      deliver,
      record: async (_p, attempt, outcome) => {
        records.push({ attempt, ...outcome });
      },
    };
    return { h, orgs, records };
  };

  it('runs every job inside its organization context and records the attempt', async () => {
    const { h, orgs, records } = handler(async () => ({ status: 'sent', providerMessageId: 'm1' }));
    await createNotificationDeliveryProcessor(h)({ id: '1', data: job, attemptsMade: 0 });
    expect(orgs).toEqual([ORG]);
    expect(records).toEqual([{ attempt: 1, status: 'sent', providerMessageId: 'm1' }]);
  });

  it('records failures and rethrows for retry', async () => {
    const { h, records } = handler(async () => {
      throw new TypeError('boom');
    });
    await expect(createNotificationDeliveryProcessor(h)({ id: '1', data: job, attemptsMade: 2 })).rejects.toThrow('boom');
    expect(records).toEqual([{ attempt: 3, status: 'failed', errorCode: 'TypeError' }]);
  });
});

describe('Gmail SMTP is dev-only (finding 7)', () => {
  const base = { EMAIL_PROVIDER: 'smtp', SMTP_HOST: 'smtp.gmail.com', SMTP_PORT: '465', EMAIL_FROM: 'MeetOps <dev@example.com>' };
  it('is allowed in development', () => expect(loadEmailConfig({ ...base, NODE_ENV: 'development' }).provider).toBe('smtp'));
  it('is refused in production', () => expect(() => loadEmailConfig({ ...base, NODE_ENV: 'production' })).toThrow(/development-only/));
});
