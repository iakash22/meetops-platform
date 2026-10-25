import { createMockAuthClient, demoAccount } from '../src/auth/mockAuthClient';
import { redactSecrets } from '../src/auth/redact';
import { createInMemoryTokenStore } from '../src/auth/tokenStore';
import { AuthClientError } from '../src/auth/types';
import { validateLogin } from '../src/auth/validation';

const account = demoAccount('ada@example.com', 'correct horse battery');

describe('validateLogin', () => {
  it('requires both fields and trims the email', () => {
    expect(validateLogin({ email: '  ', password: '' }).errors).toEqual({
      email: 'Enter your email address.',
      password: 'Enter your password.',
    });
    const ok = validateLogin({ email: ' ada@example.com ', password: 'x' });
    expect(ok.ok).toBe(true);
    expect(ok.credentials.email).toBe('ada@example.com');
  });

  it('rejects malformed email and over-long password (contracts LoginRequest limits)', () => {
    const r = validateLogin({ email: 'nope', password: 'p'.repeat(129) });
    expect(r.ok).toBe(false);
    expect(r.errors.email).toBe('Enter a valid email address.');
    expect(r.errors.password).toBe('Password is too long.');
  });
});

describe('createInMemoryTokenStore', () => {
  it('saves, loads copies and clears', async () => {
    const store = createInMemoryTokenStore();
    expect(await store.load()).toBeNull();
    const { tokens } = await createMockAuthClient({ accounts: [account] }).login(account);
    await store.save(tokens);
    const loaded = await store.load();
    expect(loaded).toEqual(tokens);
    expect(loaded).not.toBe(tokens);
    await store.clear();
    await store.clear();
    expect(await store.load()).toBeNull();
  });
});

describe('createMockAuthClient', () => {
  it('rejects bad credentials with one generic AUTH_FAILED error', async () => {
    const client = createMockAuthClient({ accounts: [account] });
    const wrongPassword = client.login({ email: account.email, password: 'nope' });
    await expect(wrongPassword).rejects.toBeInstanceOf(AuthClientError);
    await expect(wrongPassword).rejects.toMatchObject({
      code: 'AUTH_FAILED',
      message: 'Invalid email or password.',
    });
    await expect(
      client.login({ email: 'who@example.com', password: 'nope' }),
    ).rejects.toMatchObject({
      code: 'AUTH_FAILED',
      message: 'Invalid email or password.',
    });
  });

  it('returns a token-free session scoped to the token organization', async () => {
    const client = createMockAuthClient({ accounts: [account] });
    const { tokens, session } = await client.login(account);
    expect(tokens.tokenType).toBe('Bearer');
    expect(session.activeOrganizationId).toBe(tokens.organizationId);
    expect(JSON.stringify(session)).not.toMatch(/accessToken|refreshToken|csrfToken/);
    await expect(client.getSession(tokens.accessToken)).resolves.toEqual(session);
  });

  it('rotates refresh tokens and revokes the family on reuse', async () => {
    const client = createMockAuthClient({ accounts: [account] });
    const first = (await client.login(account)).tokens;
    const second = await client.refresh(first.refreshToken);
    expect(second.refreshToken).not.toBe(first.refreshToken);
    await expect(client.refresh(first.refreshToken)).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
    });
    // Family revoked: the newer pair is dead too.
    await expect(client.refresh(second.refreshToken)).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
    });
    await expect(client.getSession(second.accessToken)).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
    });
  });

  it('expires access tokens and caps the refresh family lifetime', async () => {
    let t = Date.parse('2026-10-25T00:00:00Z');
    const client = createMockAuthClient({
      accounts: [account],
      accessTtlSeconds: 60,
      refreshFamilyLifetimeSeconds: 120,
      now: () => t,
    });
    const { tokens } = await client.login(account);
    t += 61_000;
    await expect(client.getSession(tokens.accessToken)).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
    });
    const next = await client.refresh(tokens.refreshToken);
    t += 60_000;
    await expect(client.refresh(next.refreshToken)).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
    });
  });

  it('logout revokes the family', async () => {
    const client = createMockAuthClient({ accounts: [account] });
    const { tokens } = await client.login(account);
    await client.logout(tokens.refreshToken);
    await client.logout(tokens.refreshToken);
    await expect(client.getSession(tokens.accessToken)).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
    });
  });
});

describe('redactSecrets', () => {
  it('redacts every contracts REDACT_KEYS entry, deeply', () => {
    const out = redactSecrets({
      email: 'ada@example.com',
      password: 'hunter2hunter2',
      tokens: { accessToken: 'a', refreshToken: 'r', expiresAt: 'x' },
      headers: [{ Authorization: 'Bearer a' }],
    });
    expect(out).toEqual({
      email: 'ada@example.com',
      password: '[REDACTED]',
      tokens: { accessToken: '[REDACTED]', refreshToken: '[REDACTED]', expiresAt: 'x' },
      headers: [{ Authorization: '[REDACTED]' }],
    });
  });
});
