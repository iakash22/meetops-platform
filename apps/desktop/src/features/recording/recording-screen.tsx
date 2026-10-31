import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { ConsentAttestationInput, Meeting } from '@meetops/contracts';
import { Circle, Mic, Pause, Play, RotateCcw, Square, Trash2, WifiOff } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Toast } from '@/components/ui/toast';
import { useSession } from '@/features/auth/session';
import { queryMic, toAttestation, type MicState } from './consent';
import type { Recorder } from './recorder';
import {
  sha256Hex,
  type ChunkStore,
  type LocalChunk,
  type QueueItem,
  type UploadQueue,
} from './upload-queue';

export interface RecordingDeps {
  queue: UploadQueue;
  chunks: ChunkStore;
  makeRecorder: () => Recorder;
  /** True when uploads are simulated (no Rust upload commands). */
  simulated: boolean;
  queryMic?: () => Promise<MicState>;
}

type Step = 'pick' | 'optIn' | 'notice' | 'mic' | 'micDenied' | 'recording';

function useOnline(): boolean {
  return useSyncExternalStore(
    (cb) => {
      window.addEventListener('online', cb);
      window.addEventListener('offline', cb);
      return () => {
        window.removeEventListener('online', cb);
        window.removeEventListener('offline', cb);
      };
    },
    () => navigator.onLine,
  );
}

const clock = (ms: number) => {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};

const STATE_LABEL: Record<QueueItem['state'], string> = {
  pending: 'Waiting',
  uploading: 'Uploading',
  failed: 'Needs attention',
  done: 'Finishing',
};

export function RecordingScreen({
  meetings,
  deps,
}: {
  meetings: readonly Meeting[];
  deps: RecordingDeps;
}) {
  const { session } = useSession();
  const online = useOnline();
  const { queue } = deps;
  const items = useSyncExternalStore(queue.subscribe, queue.items);
  const recordable = meetings.filter((m) => m.status === 'scheduled' || m.status === 'recording');

  const [step, setStep] = useState<Step>('pick');
  const [meetingId, setMeetingId] = useState(recordable[0]?.id ?? '');
  const [notified, setNotified] = useState(false);
  const [allAgreed, setAllAgreed] = useState(false);
  const [noticeError, setNoticeError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);
  const [elapsed, setElapsed] = useState(0);

  const recorder = useRef<Recorder | null>(null);
  const consent = useRef<ConsentAttestationInput | null>(null);
  const local = useRef<{
    id: string;
    startedAt: Date;
    chunks: LocalChunk[];
    writes: Promise<void>[];
    /** Account the recording is bound to, fixed when it starts (L-7). */
    userId: string;
    organizationId: string;
    /** First chunk seq whose write failed; later chunks are dropped so the upload stays contiguous. */
    failedAt: number | null;
  } | null>(null);
  const stopRef = useRef<(reason?: string) => Promise<void>>(async () => undefined);
  const timer = useRef<{ base: number; acc: number }>({ base: 0, acc: 0 });

  // Keep the queue moving: on reconnect and every 15 s.
  useEffect(() => {
    if (online) void queue.process();
    const id = window.setInterval(() => void queue.process(), 15_000);
    return () => window.clearInterval(id);
  }, [online, queue]);

  useEffect(() => {
    if (step !== 'recording' || paused) return;
    const id = window.setInterval(
      () => setElapsed(timer.current.acc + Date.now() - timer.current.base),
      500,
    );
    return () => window.clearInterval(id);
  }, [step, paused]);

  // Stop guarantee (R7): leaving the screen always releases the microphone.
  useEffect(() => () => void recorder.current?.stop(), []);

  const meeting = recordable.find((m) => m.id === meetingId);

  const begin = useCallback(async () => {
    if (!session || !meeting) return;
    const rec = deps.makeRecorder();
    const id = crypto.randomUUID();
    local.current = {
      id,
      startedAt: new Date(),
      chunks: [],
      writes: [],
      userId: session.user.id,
      // Queue items are bound to the active org (ADR-012 3.5); live meetings are already org-filtered.
      organizationId: session.activeOrganizationId ?? meeting.organizationId,
      failedAt: null,
    };
    try {
      await rec.start((bytes) => {
        const l = local.current;
        if (!l) return;
        if (l.failedAt !== null) return;
        const seq = l.writes.length;
        l.writes.push(
          (async () => {
            const sha256 = await sha256Hex(bytes);
            try {
              await deps.chunks.put(id, seq, bytes);
            } catch {
              // e.g. the signed-in account changed (Rust refuses writes for another owner). Stop rather than
              // silently keep recording audio that can never be uploaded.
              if (l.failedAt === null || seq < l.failedAt) l.failedAt = seq;
              void stopRef.current(
                "Recording stopped: it couldn't be saved on this device. What was saved so far will still upload.",
              );
              return;
            }
            l.chunks.push({ seq, sizeBytes: bytes.byteLength, sha256 });
          })(),
        );
      });
    } catch {
      local.current = null;
      setToast("Couldn't start the microphone. Check that no other app is using it.");
      setStep('pick');
      return;
    }
    recorder.current = rec;
    timer.current = { base: Date.now(), acc: 0 };
    setElapsed(0);
    setPaused(false);
    setStep('recording');
  }, [deps, meeting, session]);

  async function afterNotice() {
    const mic = await (deps.queryMic ?? queryMic)();
    if (mic === 'unsupported') {
      setToast('This device has no microphone access.');
      setStep('pick');
    } else if (mic === 'granted') await begin();
    else setStep(mic === 'denied' ? 'micDenied' : 'mic');
  }

  function confirmNotice() {
    if (!notified) {
      setNoticeError('Confirm that everyone in the meeting knows it is being recorded.');
      return;
    }
    setNoticeError(null);
    consent.current = toAttestation(allAgreed ? 'all_parties_consented' : 'all_parties_notified');
    void afterNotice();
  }

  function togglePause() {
    const rec = recorder.current;
    if (!rec) return;
    if (paused) {
      rec.resume();
      timer.current.base = Date.now();
    } else {
      rec.pause();
      timer.current.acc += Date.now() - timer.current.base;
    }
    setPaused(!paused);
  }

  async function stop(reason?: string) {
    const rec = recorder.current;
    const l = local.current;
    if (!rec || !l) return;
    recorder.current = null;
    if (!paused) timer.current.acc += Date.now() - timer.current.base;
    await rec.stop();
    await Promise.allSettled(l.writes);
    setStep('pick');
    setNotified(false);
    setAllAgreed(false);
    local.current = null;
    if (reason) setToast(reason);
    if (!meeting || !consent.current) return;
    const kept = l.chunks.filter((c) => l.failedAt === null || c.seq < l.failedAt);
    if (kept.length === 0) {
      if (!reason) setToast('Nothing was recorded.');
      return;
    }
    // Bound to the account it started under, even if the session changed since (L-7).
    queue.enqueue({
      id: l.id,
      userId: l.userId,
      organizationId: l.organizationId,
      meetingId: meeting.id,
      meetingTitle: meeting.title,
      mimeType: rec.mimeType,
      startedAt: l.startedAt.toISOString(),
      durationMs: timer.current.acc,
      chunks: [...kept].sort((a, b) => a.seq - b.seq),
      consent: consent.current,
    });
    void queue.process();
  }

  stopRef.current = stop;

  // L-7: a recording belongs to the account it started under. If the user or org changes mid-recording, stop it
  // with a clear message; what was saved uploads when that account is active again.
  const sessionUser = session?.user.id ?? null;
  const sessionOrg = session?.activeOrganizationId ?? null;
  useEffect(() => {
    const l = local.current;
    if (step !== 'recording' || !l) return;
    if (sessionUser !== l.userId || (sessionOrg ?? l.organizationId) !== l.organizationId)
      void stopRef.current(
        'Recording stopped because your account or organization changed. It will upload when you switch back.',
      );
  }, [sessionUser, sessionOrg, step]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Record</h1>
        <p className="text-sm text-muted-foreground">
          Record a meeting on this computer. It uploads when you&apos;re online.
          {deps.simulated ? ' Preview build: uploads are simulated.' : ''}
        </p>
      </div>

      {step === 'recording' ? (
        <Card aria-live="polite">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <span
                aria-hidden
                className={`size-2.5 rounded-full bg-highlight ${paused ? '' : 'motion-safe:animate-pulse'}`}
              />
              <span data-testid="recording-indicator">{paused ? 'Paused' : 'Recording'}</span>
              <span className="font-mono text-muted-foreground" aria-label="Elapsed time">
                {clock(elapsed)}
              </span>
            </CardTitle>
            <CardDescription>{meeting?.title}</CardDescription>
          </CardHeader>
          <CardContent className="flex gap-3">
            <Button variant="outline" onClick={togglePause}>
              {paused ? <Play aria-hidden /> : <Pause aria-hidden />}
              {paused ? 'Resume' : 'Pause'}
            </Button>
            <Button onClick={() => void stop()}>
              <Square aria-hidden />
              Stop and save
            </Button>
          </CardContent>
        </Card>
      ) : step === 'pick' ? (
        <Card>
          <CardHeader>
            <CardTitle>New recording</CardTitle>
            <CardDescription>Recording is off until you turn it on for a meeting.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {recordable.length === 0 ? (
              <p className="text-sm text-muted-foreground">No scheduled meetings to record.</p>
            ) : (
              <>
                <div className="space-y-2">
                  <Label htmlFor="record-meeting">Meeting</Label>
                  <select
                    id="record-meeting"
                    value={meetingId}
                    onChange={(e) => setMeetingId(e.target.value)}
                    className="h-11 w-full rounded-md border bg-card px-3 text-base focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {recordable.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.title}
                      </option>
                    ))}
                  </select>
                </div>
                <Button variant="record" onClick={() => setStep('optIn')} disabled={!meeting}>
                  <Circle className="fill-current" aria-hidden />
                  Start recording
                </Button>
              </>
            )}
          </CardContent>
        </Card>
      ) : (
        <Card role="dialog" aria-modal="false" aria-labelledby="consent-title">
          <CardHeader>
            <CardTitle id="consent-title">
              {step === 'optIn'
                ? 'Turn on recording?'
                : step === 'notice'
                  ? 'Tell everyone first'
                  : step === 'mic'
                    ? 'Allow the microphone'
                    : 'Microphone is blocked'}
            </CardTitle>
            <CardDescription>
              {step === 'optIn'
                ? `MeetOps will record audio from "${meeting?.title ?? ''}" on this computer, store it encrypted, upload it, then delete the local copy. Local copies are deleted after 7 days even if not uploaded.`
                : step === 'notice'
                  ? 'Recording people without telling them may be illegal where you or they are.'
                  : step === 'mic'
                    ? 'Your system will ask for microphone access next. MeetOps only listens while the red indicator is on.'
                    : 'Open your system settings, allow the microphone for MeetOps, then try again.'}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {step === 'notice' ? (
              <fieldset className="space-y-3">
                <legend className="sr-only">Participant notice</legend>
                <div>
                  <label className="flex min-h-11 items-start gap-3 text-sm">
                    <input
                      type="checkbox"
                      className="mt-1 size-4 accent-primary"
                      checked={notified}
                      onChange={(e) => setNotified(e.target.checked)}
                      aria-invalid={noticeError ? true : undefined}
                      aria-describedby={noticeError ? 'notice-error' : undefined}
                    />
                    I told everyone in this meeting that it is being recorded.
                  </label>
                  {noticeError ? (
                    <p id="notice-error" className="mt-1 text-xs text-destructive-text">
                      {noticeError}
                    </p>
                  ) : null}
                </div>
                <label className="flex min-h-11 items-start gap-3 text-sm">
                  <input
                    type="checkbox"
                    className="mt-1 size-4 accent-primary"
                    checked={allAgreed}
                    onChange={(e) => setAllAgreed(e.target.checked)}
                  />
                  Everyone also agreed to be recorded.
                </label>
              </fieldset>
            ) : null}
            <div className="flex gap-3">
              <Button variant="outline" onClick={() => setStep('pick')}>
                Cancel
              </Button>
              {step === 'optIn' ? (
                <Button onClick={() => setStep('notice')}>Turn on recording</Button>
              ) : step === 'notice' ? (
                <Button onClick={confirmNotice}>Start recording</Button>
              ) : step === 'mic' ? (
                <Button onClick={() => void begin()}>
                  <Mic aria-hidden />
                  Continue
                </Button>
              ) : (
                <Button onClick={() => void afterNotice()}>Try again</Button>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            Upload queue
            {!online ? (
              <Badge variant="outline" className="gap-1">
                <WifiOff className="size-3" aria-hidden />
                Offline
              </Badge>
            ) : null}
          </CardTitle>
          <CardDescription data-testid="queue-summary">
            {items.length === 0
              ? 'Nothing waiting to upload.'
              : `${items.length} recording${items.length === 1 ? '' : 's'} waiting.${online ? '' : " Uploads resume when you're back online."}`}
          </CardDescription>
        </CardHeader>
        {items.length > 0 ? (
          <CardContent>
            <ul aria-label="Upload queue" className="divide-y divide-border">
              {items.map((i) => (
                <li key={i.id} className="flex items-center justify-between gap-4 py-3">
                  <div className="min-w-0">
                    <p className="truncate font-medium">{i.meetingTitle}</p>
                    <p className="text-xs text-muted-foreground">
                      {i.uploadedSeqs.length}/{i.chunks.length} parts
                      {i.lastError ? ` · ${i.lastError}` : ''}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge variant={i.state === 'failed' ? 'destructive' : 'default'}>
                      {STATE_LABEL[i.state]}
                    </Badge>
                    {i.state === 'failed' ? (
                      <Button size="sm" variant="outline" onClick={() => void queue.retry(i.id)}>
                        <RotateCcw aria-hidden />
                        Retry
                      </Button>
                    ) : null}
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label={`Delete recording of ${i.meetingTitle}`}
                      onClick={() =>
                        void queue
                          .discard(i.id)
                          .catch((e: unknown) => setToast((e as Error).message))
                      }
                    >
                      <Trash2 aria-hidden />
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          </CardContent>
        ) : null}
      </Card>
      <Toast message={toast} onDismiss={() => setToast(null)} />
    </div>
  );
}
