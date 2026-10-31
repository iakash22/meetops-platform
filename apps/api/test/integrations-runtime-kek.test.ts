import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import { LocalKeyProvider, TokenCipher } from '@meetops/integrations';
import { integrationsRuntimeFromEnv } from '../src/modules/integrations/runtime.js';

const ctx = {
  organizationId: '00000000-0000-4000-8000-00000000000a',
  integrationId: '00000000-0000-4000-8000-00000000000b',
};

describe('integrations runtime shared KEK (worker token refresh)', () => {
  it('keeps the random per-process key when INTEGRATIONS_TOKEN_KEK is unset or not 32 bytes', () => {
    expect(integrationsRuntimeFromEnv({}).cipher).toBeUndefined();
    expect(
      integrationsRuntimeFromEnv({
        INTEGRATIONS_TOKEN_KEK: Buffer.from('short').toString('base64'),
      }).cipher,
    ).toBeUndefined();
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
