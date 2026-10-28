import type { Meeting } from '@meetops/contracts';
import { lazy, Suspense, useMemo, useRef, useState } from 'react';

import { AppShell, type View } from '@/components/layout/app-shell';
import type { AuthClient } from '@/features/auth/auth-client';
import { SessionProvider, useSession } from '@/features/auth/session';
import { SignInScreen } from '@/features/auth/sign-in-screen';
import { createUnavailableAuthClient } from '@/features/auth/unavailable-auth';
import { invoke } from '@tauri-apps/api/core';

import { ListError, ListLoading } from '@/features/data/list-states';
import { DataProvider, createDataSource, useDataSource } from '@/features/data/repositories';
import { useOrgList } from '@/features/data/use-org-list';
import { isBrowserAuthEnabled, isMockAuthEnabled } from '@/lib/config';
import { createNativeAuthClient } from '@/lib/native-auth';
import { createMediaRecorder } from '@/features/recording/recorder';
import type { RecordingDeps } from '@/features/recording/recording-screen';
import { createNativeChunkStore } from '@/features/recording/native-chunk-store';
import { createNativeUploadApi } from '@/features/recording/native-upload-api';
import { createSimulatedUploadApi } from '@/features/recording/simulated-upload-api';
import {
  createLocalLedger,
  createMemoryChunkStore,
  createUploadQueue,
} from '@/features/recording/upload-queue';

// Only the sign-in screen is in the entry chunk; everything behind it loads on demand.
// Sign-up is mock-only for now; the guard keeps its chunk out of production builds.
const SignUpScreen = import.meta.env.DEV
  ? lazy(() => import('@/features/auth/sign-up-screen').then((m) => ({ default: m.SignUpScreen })))
  : null;
const MeetingsScreen = lazy(() =>
  import('@/features/meetings/meetings-screen').then((m) => ({ default: m.MeetingsScreen })),
);
const InsightsScreen = lazy(() =>
  import('@/features/meetings/insights-screen').then((m) => ({ default: m.InsightsScreen })),
);
const TasksScreen = lazy(() =>
  import('@/features/tasks/tasks-screen').then((m) => ({ default: m.TasksScreen })),
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

/** Record view: the meeting picker lists the active org's meetings from the data source (sample or live). */
function RecordingRoute({ deps }: { deps: RecordingDeps }) {
  const data = useDataSource();
  const { state, retry } = useOrgList(data.listMeetings);
  if (state.status === 'error') return <ListError message={state.message} onRetry={retry} />;
  if (state.status !== 'ready') return <ListLoading label="meetings" />;
  return <RecordingScreen meetings={state.items} deps={deps} />;
}

function useRecordingDeps(override: RecordingDeps | undefined, native: boolean): RecordingDeps {
  const { session } = useSession();
  const sessionRef = useRef(session);
  sessionRef.current = session;
  return useMemo(() => {
    if (override) return override;
    // Native (Tauri): presigned PUTs via Rust `upload_put` and pending chunks in the encrypted disk store.
    // Otherwise (web dev, tests) chunks stay in memory and uploads are simulated.
    const chunks = native ? createNativeChunkStore(invoke) : createMemoryChunkStore();
    const api = native ? createNativeUploadApi(invoke) : createSimulatedUploadApi();
    const queue = createUploadQueue(api, chunks, {
      isOnline: () => navigator.onLine,
      ...(native ? { ledger: createLocalLedger(window.localStorage) } : {}),
      identity: () => {
        const s = sessionRef.current;
        return s?.activeOrganizationId
          ? { userId: s.user.id, organizationId: s.activeOrganizationId }
          : null;
      },
    });
    return { queue, chunks, makeRecorder: createMediaRecorder, simulated: !native };
  }, [override, native]);
}

function Screens({
  mockAuth,
  native,
  recording,
}: {
  mockAuth: boolean;
  native: boolean;
  recording?: RecordingDeps | undefined;
}) {
  const { session, restoring } = useSession();
  const recordingDeps = useRecordingDeps(recording, native);
  const [view, setView] = useState<View>('meetings');
  const [openMeeting, setOpenMeeting] = useState<Meeting | null>(null);
  const [authView, setAuthView] = useState<'sign-in' | 'sign-up'>('sign-in');

  if (restoring) return <Loading />;
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
    <AppShell
      view={view}
      onNavigate={(v) => {
        setOpenMeeting(null);
        setView(v);
      }}
    >
      <Suspense fallback={<Loading />}>
        {view === 'meetings' && openMeeting ? (
          <InsightsScreen meeting={openMeeting} onBack={() => setOpenMeeting(null)} />
        ) : view === 'meetings' ? (
          <MeetingsScreen onRecord={() => setView('record')} onOpen={setOpenMeeting} />
        ) : view === 'tasks' ? (
          <TasksScreen />
        ) : view === 'record' ? (
          <RecordingRoute deps={recordingDeps} />
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
  browserAuth,
  recording,
}: {
  authClient?: AuthClient;
  mockAuth?: boolean;
  /** Overrides `isBrowserAuthEnabled()` (tests). */
  browserAuth?: boolean;
  recording?: RecordingDeps;
}) {
  const native = browserAuth ?? isBrowserAuthEnabled();
  // Hard-off in production: neither the prop nor env can enable the mock outside dev.
  const mock = import.meta.env.DEV && (mockAuth ?? isMockAuthEnabled());
  // ADR-012 browser + PKCE client when enabled (Tauri + VITE_DESKTOP_BROWSER_AUTH=true); otherwise mock or fail-closed.
  // The mock client is imported lazily so production (mock off) never ships it in the entry chunk.
  const client = useMemo<AuthClient>(() => {
    if (authClient) return authClient;
    if (native) return createNativeAuthClient(invoke);
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
  }, [authClient, mock, native]);
  // Live data only through the Rust `api_request` command; typed sample data otherwise.
  const data = useMemo(
    () => createDataSource(native && !authClient ? invoke : null),
    [native, authClient],
  );
  return (
    <SessionProvider client={client}>
      <DataProvider value={data}>
        <Screens mockAuth={mock} native={native && !authClient} recording={recording} />
      </DataProvider>
    </SessionProvider>
  );
}
