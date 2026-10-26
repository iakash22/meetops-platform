import { useEffect, useId, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Circle, Square, X } from 'lucide-react';
import type { ConsentMethod, Id } from '@meetops/contracts';
import { Button } from '@/components/ui/button';
import { useApi } from '@/lib/api/context';
import { queryKeys, useOrganizationId } from '@/lib/api/queries';
import { notify, toastError } from '@/lib/errors/notify';
import { CHUNK_MS, RecordingSessionUploader, type SessionState } from './session';

const CONSENT_LABEL: Record<ConsentMethod, string> = {
  all_parties_notified: 'Everyone on the call was told it is recorded',
  all_parties_consented: 'Everyone on the call agreed to be recorded',
};

const PREFERRED_MIME = ['audio/webm;codecs=opus', 'audio/webm', 'video/webm'];

export function pickMimeType(isSupported: (t: string) => boolean): string | null {
  return PREFERRED_MIME.find((t) => isSupported(t)) ?? null;
}

export function recordingSupported(): boolean {
  return (
    typeof MediaRecorder !== 'undefined' &&
    typeof navigator !== 'undefined' &&
    !!navigator.mediaDevices?.getDisplayMedia
  );
}

function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

/** Browser tab recording for a meeting (recording-session API, contracts 0.4.1). */
export function RecordingPanel({ meetingId }: { meetingId: Id }) {
  const api = useApi();
  const organizationId = useOrganizationId();
  const queryClient = useQueryClient();
  const uid = useId();
  const [state, setState] = useState<SessionState>({ phase: 'idle' });
  const [method, setMethod] = useState<ConsentMethod | null>(null);
  const [consentError, setConsentError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const uploaderRef = useRef<RecordingSessionUploader | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const startedRef = useRef(0);

  const stopTracks = () => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  };

  useEffect(() => {
    if (state.phase !== 'recording') return;
    const t = window.setInterval(() => setElapsed(Date.now() - startedRef.current), 1000);
    return () => window.clearInterval(t);
  }, [state.phase]);

  useEffect(() => {
    if (state.phase === 'error') {
      toastError(state.error, { title: 'Recording failed' });
      if (recorderRef.current?.state === 'recording') recorderRef.current.stop();
      stopTracks();
    } else if (state.phase === 'done') {
      notify.success('Recording uploaded', 'Processing starts shortly.');
      void queryClient.invalidateQueries({
        queryKey: queryKeys.meeting(organizationId, meetingId),
      });
    } else if (state.phase === 'aborted') {
      notify.info('Recording discarded');
    }
  }, [state, queryClient, organizationId, meetingId]);

  // Leaving the page mid-recording: tell the server and release the capture.
  useEffect(
    () => () => {
      if (recorderRef.current?.state === 'recording') {
        recorderRef.current.ondataavailable = null;
        recorderRef.current.stop();
        void uploaderRef.current?.abort('tab_closed');
      }
      stopTracks();
    },
    [],
  );

  if (!recordingSupported()) {
    return (
      <p className="text-sm text-muted-foreground">
        Recording needs a browser that supports tab capture. You can upload a file instead.
      </p>
    );
  }

  const start = async () => {
    if (!method) {
      setConsentError('Confirm how everyone was told about the recording.');
      return;
    }
    const mimeType = pickMimeType((t) => MediaRecorder.isTypeSupported(t));
    if (!mimeType) {
      notify.error('Recording failed', 'This browser cannot record a supported format.');
      return;
    }
    setStarting(true);
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true });
      streamRef.current = stream;
      const uploader = new RecordingSessionUploader(api, organizationId, setState);
      uploaderRef.current = uploader;
      await uploader.start({ meetingId, mimeType: mimeType.split(';')[0]!, consent: method });
      const recorder = new MediaRecorder(stream, { mimeType });
      recorderRef.current = recorder;
      recorder.ondataavailable = (e) => uploader.push(e.data);
      recorder.onstop = () => {
        stopTracks();
        void uploader.finish();
      };
      // The user ending the share from the browser bar stops the recording normally.
      stream
        .getTracks()
        .forEach((t) =>
          t.addEventListener('ended', () => recorder.state === 'recording' && recorder.stop()),
        );
      startedRef.current = Date.now();
      setElapsed(0);
      recorder.start(CHUNK_MS);
    } catch (err) {
      stopTracks();
      if (err instanceof DOMException && err.name === 'NotAllowedError')
        notify.info('Recording not started', 'Screen or tab sharing was cancelled.');
      else toastError(err, { title: 'Recording failed' });
    } finally {
      setStarting(false);
    }
  };

  const stop = () => recorderRef.current?.state === 'recording' && recorderRef.current.stop();
  const discard = () => {
    const r = recorderRef.current;
    if (r) {
      r.ondataavailable = null;
      r.onstop = null;
      if (r.state === 'recording') r.stop();
    }
    stopTracks();
    void uploaderRef.current?.abort('user_stopped');
  };

  if (state.phase === 'recording' || state.phase === 'finishing') {
    return (
      <div className="flex flex-wrap items-center gap-3" aria-live="polite">
        <span className="flex items-center gap-2 text-sm font-medium">
          <span
            className="size-2.5 rounded-full bg-destructive motion-safe:animate-pulse"
            aria-hidden
          />
          {state.phase === 'finishing'
            ? 'Finishing upload…'
            : `Recording ${formatElapsed(elapsed)}`}
        </span>
        {state.phase === 'recording' ? (
          <>
            <span className="text-xs tabular-nums text-muted-foreground">
              {state.uploaded} chunk{state.uploaded === 1 ? '' : 's'} uploaded
              {state.pending ? `, ${state.pending} pending` : ''}
            </span>
            <Button type="button" onClick={stop}>
              <Square aria-hidden />
              Stop and upload
            </Button>
            <Button type="button" variant="outline" onClick={discard}>
              <X aria-hidden />
              Discard
            </Button>
          </>
        ) : null}
      </div>
    );
  }

  return (
    <form
      aria-label="Record this meeting"
      noValidate
      className="space-y-3 text-sm"
      onSubmit={(e) => {
        e.preventDefault();
        void start();
      }}
    >
      {state.phase === 'done' ? (
        <p className="text-muted-foreground">Last recording uploaded.</p>
      ) : null}
      <fieldset
        className="space-y-2"
        aria-invalid={consentError ? true : undefined}
        aria-describedby={consentError ? `${uid}-err` : undefined}
      >
        <legend className="mb-1 text-muted-foreground">Recording consent</legend>
        {(Object.keys(CONSENT_LABEL) as ConsentMethod[]).map((m) => (
          <label key={m} className="flex min-h-11 cursor-pointer items-start gap-2">
            <input
              type="radio"
              name={`${uid}-consent`}
              checked={method === m}
              onChange={() => {
                setMethod(m);
                setConsentError(null);
              }}
              className="mt-0.5 accent-primary"
            />
            <span>{CONSENT_LABEL[m]}</span>
          </label>
        ))}
      </fieldset>
      {consentError ? (
        <p id={`${uid}-err`} className="text-destructive">
          {consentError}
        </p>
      ) : null}
      <Button type="submit" disabled={starting || !organizationId}>
        <Circle aria-hidden />
        {starting ? 'Starting…' : 'Start recording'}
      </Button>
    </form>
  );
}
