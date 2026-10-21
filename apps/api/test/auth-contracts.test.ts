import { describe, it, expect, afterEach } from 'vitest';
import { sessionResponseSchema, signupRequestSchema } from '../src/modules/auth/contracts';
import { buildApp, type App } from './helpers';

describe('auth zod contracts', () => {
  let app: App;
  afterEach(async () => app.close());
  it('signup response matches the zod contract and never leaks secrets', async () => {
    app = await buildApp();
    const input = signupRequestSchema.parse({ email: ' Zed@Example.com ', password: 'correct-horse-battery' });
    expect(input.email).toBe('zed@example.com');
    const res = await app.inject({ method: 'POST', url: '/auth/signup', payload: input });
    expect(sessionResponseSchema.safeParse(res.json()).success).toBe(true);
    expect(res.body).not.toContain('correct-horse-battery');
    expect(res.body).not.toContain('argon2');
  });
});
