import { lazy, Suspense, useMemo, useRef, useState } from 'react';

import { AppShell, type View } from '@/components/layout/app-shell';
import type { AuthClient } from '@/features/auth/auth-client';
import { SessionProvider, useSession } from '@/features/auth/session';
import { SignInScreen } from '@/features/auth/sign-in-screen';
import { createUnavailableAuthClient } from '@/features/auth/unavailable-auth';
import { SAMPLE_MEETINGS } from '@/features/meetings/sample-meetings';
import { createMediaRecorder } from '@/features/recording/recorder';
import type { RecordingDeps } from '@/features/recording/recording-screen';
import { createSimulatedUploadApi } from '@/features/recording/simulated-upload-api';
import { createMemoryChunkStore, createUploadQueue } from '@/features/recording/upload-queue';
import { isMockAuthEnabled } from '@/lib/config';

// Only the sign-in screen is in the entry chunk; everything behind it loads on demand.
// Sign-up is mock-only for now; the guard keeps its chunk out of production builds.
const SignUpScreen = import.meta.env.DEV
  ? lazy(() => import('@/features/auth/sign-up-screen').then((m) => ({ default: m.SignUpScreen })))
  : null;
const MeetingsScreen = lazy(() =>
  import('@/features/meetings/meetings-screen').then((m) => ({ default: m.MeetingsScreen })),
);
const RecordingScreen = lazy(() =>
  import('@/features/recording/recording-screen').then((m) => ({ default: m.RecordingScreen })),
);
const SettingsScreen = lazy(() =>
  import('@/features/settings/settings-screen').then((m) => ({ default: m.SettingsScreen })),
);

function Loading() {
  return (
    <p role="status" className="p-6 text-sm text-muted-foreground">
      Loading…
    </p>
  );
}

function useRecordingDeps(override: RecordingDeps | undefined): RecordingDeps {
  const { session } = useSession();
  const sessionRef = useRef(session);
  sessionRef.current = session;
  return useMemo(() => {
    if (override) return override;
    // TODO(desktop-recording): swap for createNativeUploadApi(invoke) + encrypted disk store once the
    // Rust commands land (Cargo.lock slot). Until then chunks stay in memory and uploads are simulated.
    const chunks = createMemoryChunkStore();
    const queue = createUploadQueue(createSimulatedUploadApi(), chunks, {
      isOnline: () => navigator.onLine,
      identity: () => {
        const s = sessionRef.current;
        return s?.activeOrganizationId
          ? { userId: s.user.id, organizationId: s.activeOrganizationId }
          : null;
      },
    });
    return { queue, chunks, makeRecorder: createMediaRecorder, simulated: true };
  }, [override]);
}

function Screens({
  mockAuth,
  recording,
}: {
  mockAuth: boolean;
  recording?: RecordingDeps | undefined;
}) {
  const { session } = useSession();
  const recordingDeps = useRecordingDeps(recording);
  const [view, setView] = useState<View>('meetings');
  const [authView, setAuthView] = useState<'sign-in' | 'sign-up'>('sign-in');

  if (!session) {
    return SignUpScreen && mockAuth && authView === 'sign-up' ? (
      <Suspense fallback={<Loading />}>
        <SignUpScreen onSignIn={() => setAuthView('sign-in')} />
      </Suspense>
    ) : (
      <SignInScreen mockAuth={mockAuth} onCreateAccount={() => setAuthView('sign-up')} />
    );
  }
  return (
    <AppShell view={view} onNavigate={setView}>
      <Suspense fallback={<Loading />}>
        {view === 'meetings' ? (
          <MeetingsScreen onRecord={() => setView('record')} />
        ) : view === 'record' ? (
          <RecordingScreen meetings={SAMPLE_MEETINGS} deps={recordingDeps} />
        ) : (
          <SettingsScreen />
        )}
      </Suspense>
    </AppShell>
  );
}

export function App({
  authClient,
  mockAuth,
  recording,
}: {
  authClient?: AuthClient;
  mockAuth?: boolean;
  recording?: RecordingDeps;
}) {
  // Hard-off in production: neither the prop nor env can enable the mock outside dev.
  const mock = import.meta.env.DEV && (mockAuth ?? isMockAuthEnabled());
  // TODO(desktop-auth): replace with the ADR-012 browser + PKCE client once the ADR is signed off.
  // The mock client is imported lazily so production (mock off) never ships it in the entry chunk.
  const client = useMemo<AuthClient>(() => {
    if (authClient) return authClient;
    if (import.meta.env.DEV && mock) {
      // DEV-guarded so the bundler drops the mock-auth chunk from production builds.
      let real: AuthClient | null = null;
      const load = async () =>
        (real ??= (await import('@/features/auth/mock-auth')).createMockAuthClient());
      return {
        signIn: async (r) => (await load()).signIn(r),
        signUp: async (r) => (await load()).signUp(r),
        signOut: async () => (await load()).signOut(),
      };
    }
    return createUnavailableAuthClient();
  }, [authClient, mock]);
  return (
    <SessionProvider client={client}>
      <Screens mockAuth={mock} recording={recording} />
    </SessionProvider>
  );
}
