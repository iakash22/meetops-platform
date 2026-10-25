import { describe, it, expect } from 'vitest';
import { loadEmailConfig, redactEmailConfig } from '../src';

const base = {
  EMAIL_PROVIDER: 'smtp',
  SMTP_HOST: 'smtp.example.test',
  EMAIL_FROM: 'MeetOps <no-reply@example.test>',
};

describe('loadEmailConfig', () => {
  it('defaults port 465 and secure=true', () => {
    const cfg = loadEmailConfig(base);
    expect(cfg).toMatchObject({ provider: 'smtp', port: 465, secure: true });
  });
  it('secure defaults false for 587 and parses explicit SMTP_SECURE', () => {
    expect(loadEmailConfig({ ...base, SMTP_PORT: '587' })).toMatchObject({
      port: 587,
      secure: false,
    });
    expect(loadEmailConfig({ ...base, SMTP_PORT: '587', SMTP_SECURE: 'true' })).toMatchObject({
      secure: true,
    });
  });
  it('requires host and from', () => {
    expect(() => loadEmailConfig({ EMAIL_PROVIDER: 'smtp' })).toThrow(
      /Invalid email configuration|Unsupported EMAIL_PROVIDER/,
    );
  });
  it('requires user and password together', () => {
    expect(() => loadEmailConfig({ ...base, SMTP_USER: 'u' })).toThrow(/together/);
  });
  it('rejects unknown provider and console in production', () => {
    expect(() => loadEmailConfig({ ...base, EMAIL_PROVIDER: 'ses' })).toThrow(
      /Invalid email configuration|Unsupported EMAIL_PROVIDER/,
    );
    expect(() => loadEmailConfig({ EMAIL_PROVIDER: 'console', NODE_ENV: 'production' })).toThrow();
  });
  it('never leaks the password in errors or redacted output', () => {
    const secret = 'sup3r-s3cret-pw';
    try {
      loadEmailConfig({ ...base, SMTP_PORT: 'notanumber', SMTP_USER: 'u', SMTP_PASSWORD: secret });
      throw new Error('expected failure');
    } catch (e) {
      expect((e as Error).message).not.toContain(secret);
    }
    const cfg = loadEmailConfig({ ...base, SMTP_USER: 'u', SMTP_PASSWORD: secret });
    expect(JSON.stringify(redactEmailConfig(cfg))).not.toContain(secret);
  });
  it('explicit SMTP_SECURE=false on 465 parses to a real false (zod 4 boolean parsing)', () => {
    const cfg = loadEmailConfig({ ...base, SMTP_SECURE: 'false' });
    expect(cfg).toMatchObject({ port: 465, secure: false });
    expect(typeof (cfg as { secure: unknown }).secure).toBe('boolean');
  });
  it('reports invalid SMTP_SECURE and SMTP_PORT by key with stable messages', () => {
    expect(() => loadEmailConfig({ ...base, SMTP_SECURE: 'maybe' })).toThrow(
      /^Invalid email configuration: SMTP_SECURE: Invalid boolean string$/,
    );
    expect(() => loadEmailConfig({ ...base, SMTP_PORT: '70000' })).toThrow(/SMTP_PORT: /);
    expect(() => loadEmailConfig({ ...base, SMTP_PASSWORD: 'p' })).toThrow(
      /config: SMTP_USER and SMTP_PASSWORD must be set together/,
    );
  });
  it('console provider applies its default EMAIL_FROM', () => {
    expect(loadEmailConfig({ EMAIL_PROVIDER: 'console' })).toEqual({
      provider: 'console',
      from: 'MeetOps <no-reply@meetops.local>',
    });
  });
});
