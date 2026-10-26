/** Audio capture port. The webview MediaRecorder impl needs no plugin; a native (Rust) recorder can replace it. */
export interface Recorder {
  readonly mimeType: string;
  start: (onChunk: (bytes: Uint8Array) => void) => Promise<void>;
  pause: () => void;
  resume: () => void;
  /** Stop guarantee: always releases the microphone, even if the recorder errored. */
  stop: () => Promise<void>;
}

/** 10 s timeslices keep each chunk far below MAX_CHUNK_BYTES (64 MB) for opus audio. */
export const CHUNK_TIMESLICE_MS = 10_000;

const PREFERRED = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'];

export function createMediaRecorder(): Recorder {
  let stream: MediaStream | null = null;
  let rec: MediaRecorder | null = null;
  let pending: Promise<void>[] = [];
  const mimeType =
    typeof MediaRecorder !== 'undefined'
      ? (PREFERRED.find((t) => MediaRecorder.isTypeSupported(t)) ?? 'audio/webm')
      : 'audio/webm';
  const release = () => {
    stream?.getTracks().forEach((t) => t.stop());
    stream = null;
  };
  return {
    mimeType,
    async start(onChunk) {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      rec = new MediaRecorder(stream, { mimeType });
      rec.ondataavailable = (e) => {
        if (e.data.size === 0) return;
        pending.push(e.data.arrayBuffer().then((b) => onChunk(new Uint8Array(b))));
      };
      rec.onerror = release;
      rec.start(CHUNK_TIMESLICE_MS);
    },
    pause: () => rec?.state === 'recording' && rec.pause(),
    resume: () => rec?.state === 'paused' && rec.resume(),
    async stop() {
      try {
        if (rec && rec.state !== 'inactive') {
          const r = rec;
          await new Promise<void>((resolve) => {
            r.onstop = () => resolve();
            r.stop();
          });
        }
        await Promise.all(pending);
      } finally {
        pending = [];
        rec = null;
        release();
      }
    },
  };
}
