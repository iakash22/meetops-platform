import { ChunkQueue, type UploadClient } from "./upload.js";

export const MIME_TYPE = "audio/webm;codecs=opus";
export const TIMESLICE_MS = 5000;

export interface RecorderEvents {
  onStarted(sessionId: string): void;
  onChunk(seq: number): void;
  onStopped(chunkCount: number): void;
  onError(error: string): void;
}

/** Minimal MediaRecorder surface we rely on (injectable for tests). */
export interface RecorderLike {
  state: string;
  ondataavailable: ((e: { data: Blob }) => void) | null;
  onstop: (() => void) | null;
  onerror: ((e: unknown) => void) | null;
  start(timeslice?: number): void;
  stop(): void;
}

export interface RecordingHandle {
  stop(): void;
}

/**
 * Starts MediaRecorder on an already-obtained stream and pipes timesliced
 * webm/opus chunks into the upload client in sequence order.
 */
export async function startRecording(opts: {
  stream: MediaStream;
  client: UploadClient;
  createRecorder: (stream: MediaStream, mimeType: string) => RecorderLike;
  events: RecorderEvents;
  startedAt: number;
  now?: () => number;
  timeslice?: number;
}): Promise<RecordingHandle> {
  const now = opts.now ?? Date.now;
  const { sessionId } = await opts.client.initSession({ mimeType: MIME_TYPE, startedAt: opts.startedAt, source: "tab" });
  const queue = new ChunkQueue(opts.client, sessionId, (seq) => opts.events.onChunk(seq));
  const rec = opts.createRecorder(opts.stream, MIME_TYPE);
  const stopTracks = () => opts.stream.getTracks().forEach((t) => t.stop());

  rec.ondataavailable = (e) => {
    if (e.data.size > 0) queue.push(e.data);
  };
  rec.onerror = (e) => {
    stopTracks();
    opts.events.onError(e instanceof Error ? e.message : "MediaRecorder error");
  };
  rec.onstop = () => {
    stopTracks();
    void (async () => {
      try {
        await queue.flush();
        await opts.client.complete(sessionId, { chunkCount: queue.count, durationMs: now() - opts.startedAt });
        opts.events.onStopped(queue.count);
      } catch (err) {
        await opts.client.abort?.(sessionId, String(err)).catch(() => undefined);
        opts.events.onError(err instanceof Error ? err.message : String(err));
      }
    })();
  };
  // Stop if the user ends capture from Chrome's own UI or the tab closes.
  opts.stream.getTracks().forEach((t) =>
    t.addEventListener("ended", () => {
      if (rec.state !== "inactive") rec.stop();
    })
  );

  rec.start(opts.timeslice ?? TIMESLICE_MS);
  opts.events.onStarted(sessionId);
  return {
    stop() {
      if (rec.state !== "inactive") rec.stop();
    }
  };
}
