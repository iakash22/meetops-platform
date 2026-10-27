import { describe, expect, it, vi } from 'vitest';
import { EmailConfigError } from '@meetops/notifications';
import { createServer } from '../src/server.js';
import {
  defaultModuleDeps,
  MissingProductionDependencyError,
  type ModuleDeps,
} from '../src/modules/index.js';
import { InlineAuthMailQueue } from '../src/modules/auth/application/auth-mail.handler.js';
import type { MailTransport } from '../src/modules/auth/domain/mail-jobs.js';
import { Client, fakeHasher, PASSWORD } from './helpers.js';

const DB_URL = 'postgresql://unit:unit@127.0.0.1:1/unit';
const REDIS_URL = 'redis://127.0.0.1:1';

async function appWith(mailTransport: MailTransport, deps: Partial<ModuleDeps> = {}) {
  const app = createServer({ deps: { hasher: fakeHasher, ...deps, mailTransport } });
  await app.ready();
  return app;
}

type Snap = { status: number; body: unknown };
async function flow(app: Awaited<ReturnType<typeof appWith>>): Promise<Snap[]> {
  const c = new Client(app as never);
  const out: Snap[] = [];
  const keep = (r: { statusCode: number; json(): unknown }) =>
    out.push({ status: r.statusCode, body: r.json() });
  keep(await c.post('/auth/signup', { name: 'A', email: 'a@example.test', password: PASSWORD }));
  // Duplicate signup (account_exists mail) and resend for both a known and an unknown address.
  keep(await c.post('/auth/signup', { name: 'A', email: 'a@example.test', password: PASSWORD }));
  keep(await c.post('/auth/resend-verification', { email: 'a@example.test' }));
  keep(await c.post('/auth/resend-verification', { email: 'nobody@example.test' }));
  return out;
}

describe('email delivery wiring', () => {
  it('signup and resend hand the verification mail to the transport', async () => {
    const send = vi.fn(async () => {});
    const app = await appWith({ send });
    await flow(app);
    const kinds = send.mock.calls.map(
      (c) => (c as unknown as [{ template: string; to: string }])[0],
    );
    expect(kinds.filter((m) => m.template === 'email_verification')).toHaveLength(2);
    expect(kinds.every((m) => m.to === 'a@example.test')).toBe(true);
    await app.close();
  });

  it('a failing transport never yields a 500 or a different response, and is logged without secrets', async () => {
    const ok = await appWith({ send: async () => {} });
    const good = await flow(ok);
    await ok.close();

    const failing = await appWith({
      send: async () => {
        const e = new Error('535 auth failed for user@example.test token=abc') as Error & {
          code: string;
          responseCode: number;
        };
        e.code = 'EAUTH';
        e.responseCode = 535;
        throw e;
      },
    });
    const errors: unknown[] = [];
    const spy = vi.spyOn(failing.log, 'error').mockImplementation((obj: unknown) => {
      errors.push(obj);
    });
    const bad = await flow(failing);
    expect(bad).toEqual(good);
    expect(bad.every((r) => r.status < 500)).toBe(true);
    expect(errors.length).toBeGreaterThan(0);
    const logged = JSON.stringify(errors);
    expect(logged).toContain('EAUTH');
    expect(logged).not.toContain('token=abc');
    expect(logged).not.toContain('user@example.test');
    spy.mockRestore();
    await failing.close();
  });

  it('InlineAuthMailQueue swallows handler errors', async () => {
    const q = new InlineAuthMailQueue();
    const error = vi.fn();
    q.log = { warn: vi.fn(), error };
    q.handler = { handle: async () => Promise.reject(new Error('boom')) } as never;
    await expect(
      q.enqueue({ kind: 'account_exists', userId: 'u' } as never),
    ).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledWith(
      { kind: 'account_exists', err: { type: 'Error' } },
      'auth mail delivery failed',
    );
  });

  it('development without email env falls back to the console sender (no network)', () => {
    const deps = defaultModuleDeps({}, { nodeEnv: 'development' });
    expect(typeof deps.mailTransport.send).toBe('function');
  });

  it('test env ignores email env even when set', () => {
    expect(() =>
      defaultModuleDeps({}, { nodeEnv: 'test', emailEnv: { EMAIL_PROVIDER: 'resend' } }),
    ).not.toThrow();
  });
});

describe('production email config', () => {
  const strict = { nodeEnv: 'production', databaseUrl: DB_URL, redisUrl: REDIS_URL };
  const queue = { mailQueue: {} as never };

  it('refuses to start without email config', () => {
    expect(() => defaultModuleDeps(queue, strict)).toThrow(MissingProductionDependencyError);
    expect(() => defaultModuleDeps(queue, strict)).toThrow(/mailTransport/);
  });

  it('fails fast with EmailConfigError when configured but invalid, without leaking values', () => {
    const run = () =>
      defaultModuleDeps(queue, {
        ...strict,
        emailEnv: { EMAIL_PROVIDER: 'resend', RESEND_API_KEY: 're_secret_value' },
      });
    expect(run).toThrow(EmailConfigError);
    expect(run).toThrow(/EMAIL_FROM/);
    try {
      run();
    } catch (e) {
      expect((e as Error).message).not.toContain('re_secret_value');
    }
  });

  it('a valid SMTP or Resend config satisfies mailTransport', () => {
    for (const emailEnv of [
      {
        EMAIL_PROVIDER: 'smtp',
        SMTP_HOST: 'smtp.example.test',
        SMTP_USER: 'u',
        SMTP_PASSWORD: 'p',
        EMAIL_FROM: 'x@example.test',
      },
      { EMAIL_PROVIDER: 'resend', RESEND_API_KEY: 'k', EMAIL_FROM: 'x@example.test' },
    ]) {
      let missing: string[] = [];
      try {
        defaultModuleDeps({}, { ...strict, emailEnv });
      } catch (e) {
        if (!(e instanceof MissingProductionDependencyError)) throw e;
        missing = e.missing;
      }
      expect(missing).toEqual(['mailQueue']);
    }
  });
});
