import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import { LocalKeyProvider, TokenCipher } from '@meetops/integrations';
import { integrationsRuntimeFromEnv } from '../src/modules/integrations/runtime.js';
import { selectIntegrationsRuntime } from '../src/modules/integrations/index.js';

const ctx = {
  organizationId: '00000000-0000-4000-8000-00000000000a',
  integrationId: '00000000-0000-4000-8000-00000000000b',
};

describe('integrations runtime shared KEK (worker token refresh)', () => {
  it('keeps the random per-process key when INTEGRATIONS_TOKEN_KEK is unset or blank', () => {
    expect(integrationsRuntimeFromEnv({}).cipher).toBeUndefined();
    expect(integrationsRuntimeFromEnv({ INTEGRATIONS_TOKEN_KEK: '  ' }).cipher).toBeUndefined();
  });

  it.each([
    ['too short', Buffer.from('short').toString('base64')],
    ['too long', randomBytes(33).toString('base64')],
    ['unpadded', randomBytes(32).toString('base64').replace(/=$/, '')],
    ['url-safe alphabet', randomBytes(32).toString('base64url') + '='],
    ['non-canonical trailing bits', randomBytes(32).toString('base64').replace(/.=$/, 'B=')],
    ['not base64', '!'.repeat(43) + '='],
  ])('throws at startup when set but invalid (%s), naming only the variable', (_n, value) => {
    // Guard: the non-canonical case must really be non-canonical.
    if (_n === 'non-canonical trailing bits')
      expect(Buffer.from(value, 'base64').toString('base64')).not.toBe(value);
    let msg = '';
    try {
      integrationsRuntimeFromEnv({ INTEGRATIONS_TOKEN_KEK: value });
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toMatch(/INTEGRATIONS_TOKEN_KEK/);
    expect(msg).not.toContain(value);
  });

  it('refuses the dev KEK when NODE_ENV=production (ADR-008)', () => {
    const value = randomBytes(32).toString('base64');
    expect(() =>
      integrationsRuntimeFromEnv({ NODE_ENV: 'production', INTEGRATIONS_TOKEN_KEK: value }),
    ).toThrow(/INTEGRATIONS_TOKEN_KEK.*production/);
  });

  it('seals with the shared key so the worker (key id "shared") can decrypt', async () => {
    const kek = randomBytes(32);
    const cipher = integrationsRuntimeFromEnv({
      INTEGRATIONS_TOKEN_KEK: kek.toString('base64'),
    }).cipher!;
    const sealed = await cipher.encrypt('tok', ctx);
    const worker = new TokenCipher(new LocalKeyProvider({ shared: kek }, 'shared'));
    await expect(worker.decrypt(sealed, ctx)).resolves.toBe('tok');
  });
});

describe('API startup refuses INTEGRATIONS_TOKEN_KEK under NODE_ENV=production', () => {
  const value = randomBytes(32).toString('base64');
  const env = { NODE_ENV: 'production', INTEGRATIONS_TOKEN_KEK: value };

  it('throws instead of silently ignoring the KEK, naming only the variable', () => {
    let msg = '';
    try {
      selectIntegrationsRuntime({} as never, 'production', env);
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toMatch(/INTEGRATIONS_TOKEN_KEK.*production/);
    expect(msg).not.toContain(value);
  });

  it('throws even when a runtime is injected', () => {
    expect(() =>
      selectIntegrationsRuntime({ integrationsRuntime: {} } as never, 'production', env),
    ).toThrow(/INTEGRATIONS_TOKEN_KEK/);
  });

  it('starts normally in production when the KEK is unset or blank', () => {
    expect(
      selectIntegrationsRuntime({} as never, 'production', { NODE_ENV: 'production' }),
    ).toBeUndefined();
    expect(
      selectIntegrationsRuntime({} as never, 'production', {
        NODE_ENV: 'production',
        INTEGRATIONS_TOKEN_KEK: ' ',
      }),
    ).toBeUndefined();
  });
});
