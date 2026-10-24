import { describe, expect, it } from 'vitest';
import { createCredentialResolver, credentialRefSchema, orgAIConfigSchema, parseCredentialRef, parseOrgSecretRef } from '../src/index.js';
import { admin, setup } from './helpers.js';

const A = '00000000-0000-4000-8000-0000000000a1';
const B = '00000000-0000-4000-8000-0000000000b2';

const BAD = [
  `secret:org/${A}/../${B}/key`,
  `secret:org/${A}/./key`,
  `secret:org/${A}/%2e%2e/${B}/key`,
  `secret:org/${A}/%2E%2E/key`,
  `secret:org/${A}\\..\\${B}\\key`,
  `secret:org\\${A}\\key`,
  `secret:org//${A}/key`,
  `secret:org/${A}//key`,
  `secret:/org/${A}/key`,
  `secret:org/${A}/key/`,
  'secret:',
  'secret:..',
  `secret:org/${A}/ke y`,
  'env:gemini_api_key',
  'env:GEMINI-API-KEY',
  'env:../GEMINI',
  'env:',
  'env:GEMINI%5FKEY',
  'AIzaRawKey123',
];

describe('C1: strict credential ref parser', () => {
  it.each(BAD)('rejects %s everywhere', (ref) => {
    expect(parseCredentialRef(ref)).toBeNull();
    expect(credentialRefSchema.safeParse(ref).success).toBe(false);
  });

  it('accepts valid refs and returns canonical parts', () => {
    expect(parseCredentialRef('env:GEMINI_API_KEY')).toEqual({ kind: 'env', name: 'GEMINI_API_KEY' });
    expect(parseCredentialRef(`secret:org/${A}/gemini_key-1`)).toEqual({ kind: 'secret', segments: ['org', A, 'gemini_key-1'], path: `org/${A}/gemini_key-1` });
    expect(credentialRefSchema.safeParse(`secret:org/${A}/a/b`).success).toBe(true);
  });

  it('binds org by exact first segments', () => {
    expect(parseOrgSecretRef(`secret:org/${A}/k`, A)).not.toBeNull();
    expect(parseOrgSecretRef(`secret:org/${B}/k`, A)).toBeNull();
    expect(parseOrgSecretRef(`secret:org/${A}x/k`, A)).toBeNull();
    expect(parseOrgSecretRef(`secret:org/${A}`, A)).toBeNull();
    expect(parseOrgSecretRef(`secret:orgs/${A}/k`, A)).toBeNull();
    expect(parseOrgSecretRef(`secret:org/${A}/../${B}/k`, A)).toBeNull();
  });

  it('resolver never queries the store for traversal or cross-org refs', async () => {
    const asked: string[] = [];
    const resolve = createCredentialResolver(
      { env: () => 'platform', secret: async (p) => { asked.push(p); return 'byo'; } },
      async () => ({ platformKeys: true }),
    );
    for (const ref of [`secret:org/${A}/../${B}/key`, `secret:org/${A}/%2e%2e/${B}/key`, `secret:org/${A}\\..\\${B}\\key`, `secret:org//${B}/key`, `secret:org/${B}/key`]) {
      await expect(resolve(ref, { organizationId: A })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    }
    await expect(resolve('env:bad-name', { organizationId: A })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(asked).toEqual([]);
    await expect(resolve(`secret:org/${A}/key`, { organizationId: A })).resolves.toBe('byo');
    expect(asked).toEqual([`org/${A}/key`]);
    await expect(resolve('env:GEMINI_API_KEY', { organizationId: A })).resolves.toBe('platform');
  });

  it('router setOrgConfig rejects traversal, encoded and cross-org refs', async () => {
    const s = await setup({ providers: {}, configs: [] });
    for (const ref of [`secret:org/${A}/../${B}/key`, `secret:org/${A}/%2e%2e/key`, `secret:org/${A}\\key`, `secret:org/${A}//key`, `secret:org/${B}/key`]) {
      await expect(s.router.setOrgConfig({ organizationId: A, credentialRefs: { gemini: ref } }, admin(A))).rejects.toThrow();
    }
    expect(orgAIConfigSchema.safeParse({ organizationId: A, credentialRefs: { gemini: `secret:org/${A}/../${B}/k` } }).success).toBe(false);
    await expect(s.router.setOrgConfig({ organizationId: A, credentialRefs: { gemini: `secret:org/${A}/gemini` } }, admin(A))).resolves.not.toThrow();
    expect((await s.orgStore.get(A))?.credentialRefs).toEqual({ gemini: `secret:org/${A}/gemini` });
  });
});
