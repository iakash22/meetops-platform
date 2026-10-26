import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { App } from '@/app';
import { AuthError, type AuthClient, type DesktopSession } from '@/features/auth/auth-client';
import { createMockAuthClient } from '@/features/auth/mock-auth';
import { createDataSource } from '@/features/data/repositories';
import { isBrowserAuthEnabled } from '@/lib/config';
import { createNativeAuthClient, type Invoke } from '@/lib/native-auth';

const ORG = '00000000-0000-4000-8000-000000000001';
const session: DesktopSession = {
  user: {
    id: '30000000-0000-4000-8000-000000000001',
    email: 'alex@example.com',
    name: 'Alex',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
  activeOrganizationId: ORG,
  organizations: [{ id: ORG, name: 'Acme', slug: 'acme', role: 'owner' }],
} as unknown as DesktopSession;

const invokeWith = (impl: (cmd: string, args?: Record<string, unknown>) => unknown) =>
  vi.fn(async (cmd: string, args?: Record<string, unknown>) =>
    impl(cmd, args),
  ) as unknown as Invoke;

describe('ADR-012 native auth bridge', () => {
  it('is off unless inside Tauri with the flag set', () => {
    const env = { VITE_DESKTOP_BROWSER_AUTH: 'true' } as unknown as ImportMetaEnv;
    expect(isBrowserAuthEnabled(env, false)).toBe(false);
    expect(isBrowserAuthEnabled({} as ImportMetaEnv, true)).toBe(false);
    expect(isBrowserAuthEnabled(env, true)).toBe(true);
  });

  it('signs in through auth_sign_in and never accepts a password', async () => {
    const invoke = invokeWith((cmd) => (cmd === 'auth_sign_in' ? session : null));
    const client = createNativeAuthClient(invoke);
    await expect(client.signInWithBrowser?.()).resolves.toEqual(session);
    await expect(
      client.signIn({ email: 'a@b.co', password: 'x'.repeat(12) }),
    ).rejects.toBeInstanceOf(AuthError);
  });

  it('refuses any IPC response carrying a token', async () => {
    const invoke = invokeWith(() => ({ ...session, nested: { refreshToken: 'r' } }));
    await expect(createNativeAuthClient(invoke).signInWithBrowser?.()).rejects.toThrow(/unsafe/);
  });

  it('maps native errors and hides unknown failures', async () => {
    const typed = invokeWith(() => {
      throw { code: 'RATE_LIMITED', message: 'Slow down.' };
    });
    await expect(createNativeAuthClient(typed).signInWithBrowser?.()).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      message: 'Slow down.',
    });
    const raw = invokeWith(() => {
      throw 'command auth_sign_in not found';
    });
    await expect(createNativeAuthClient(raw).signInWithBrowser?.()).rejects.toMatchObject({
      code: 'INTERNAL',
      message: expect.not.stringContaining('command') as unknown as string,
    });
  });

  it('restore treats a dead token family as signed out', async () => {
    const invoke = invokeWith(() => {
      throw { code: 'UNAUTHENTICATED', message: 'expired' };
    });
    await expect(createNativeAuthClient(invoke).restore?.()).resolves.toBeNull();
  });
});

describe('desktop data source', () => {
  it('serves typed sample data scoped to the org', async () => {
    const data = createDataSource(null);
    expect(data.sample).toBe(true);
    expect((await data.listTasks(ORG)).length).toBeGreaterThan(0);
    expect(await data.listMeetings('other-org')).toEqual([]);
  });

  it('reads through api_request and filters other-org rows', async () => {
    const invoke = invokeWith((_cmd, args) => ({
      items: [
        { id: 't1', organizationId: ORG, title: 'Mine' },
        { id: 't2', organizationId: 'other', title: 'Leak' },
      ],
      nextCursor: null,
      path: undefined,
      echoed: args,
    }));
    const tasks = await createDataSource(invoke).listTasks(ORG);
    expect(tasks.map((t) => t.id)).toEqual(['t1']);
    expect(invoke).toHaveBeenCalledWith('api_request', {
      method: 'GET',
      path: `/orgs/${ORG}/tasks?limit=50`,
    });
  });
});

describe('desktop app with browser sign-in', () => {
  const browserClient = (over: Partial<AuthClient> = {}): AuthClient => ({
    ...createMockAuthClient({ delayMs: 0 }),
    signInWithBrowser: async () => session,
    ...over,
  });

  it('enables the browser button and lands on meetings', async () => {
    const user = userEvent.setup();
    render(<App authClient={browserClient()} mockAuth={false} />);
    await user.click(screen.getByRole('button', { name: /sign in with your browser/i }));
    expect(await screen.findByRole('heading', { name: 'Meetings' })).toBeInTheDocument();
    expect(await screen.findByRole('list', { name: 'Meetings' })).toBeInTheDocument();
  });

  it('shows browser sign-in failures as a toast', async () => {
    const user = userEvent.setup();
    render(
      <App
        authClient={browserClient({
          signInWithBrowser: () => Promise.reject(new AuthError('INTERNAL', 'Loopback blocked.')),
        })}
        mockAuth={false}
      />,
    );
    await user.click(screen.getByRole('button', { name: /sign in with your browser/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Loopback blocked.');
    expect(screen.getByRole('button', { name: /sign in with your browser/i })).toBeEnabled();
  });

  it('restores a stored session on launch and shows tasks', async () => {
    const user = userEvent.setup();
    render(<App authClient={browserClient({ restore: async () => session })} mockAuth={false} />);
    await user.click(await screen.findByRole('button', { name: 'Tasks' }));
    expect(await screen.findByRole('list', { name: 'Tasks' })).toBeInTheDocument();
    expect(screen.getByText('In progress')).toBeInTheDocument();
  });
});
