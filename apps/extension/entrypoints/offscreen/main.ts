/// <reference types="chrome" />
import { HEARTBEAT_INTERVAL_MS } from '../../src/lib/background-handler.js';
import { ChunkStore } from '../../src/lib/chunk-store.js';
import { isOffscreenMessage, type OffscreenToBackground } from '../../src/lib/messages.js';
import { startRecording, type RecorderLike, type RecordingHandle } from '../../src/lib/recorder.js';
import { extensionUrls, isTrustedOffscreenSender } from '../../src/lib/senders.js';
import { StubUploadClient } from '../../src/lib/upload.js';

// TODO: swap for the real HTTP client once the chunked upload API exists.
const client = new StubUploadClient();
let handle: RecordingHandle | undefined;
let audioCtx: AudioContext | undefined;
let heartbeat: ReturnType<typeof setInterval> | undefined;
let storePromise: Promise<ChunkStore> | undefined;

const emit = (msg: OffscreenToBackground) => {
  void chrome.runtime.sendMessage(msg).catch(() => undefined);
};

async function start(streamId: string, startedAt: number, meetingId: string) {
  if (handle) throw new Error('Already recording');
  const store = await (storePromise ??= ChunkStore.open());
  const constraints = {
    audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } },
    video: false,
  } as unknown as MediaStreamConstraints;
  const stream = await navigator.mediaDevices.getUserMedia(constraints);
  // Tab capture mutes the tab by default; route audio back so the user still hears the meeting.
  audioCtx = new AudioContext();
  audioCtx.createMediaStreamSource(stream).connect(audioCtx.destination);
  handle = await startRecording({
    stream,
    client,
    store,
    startedAt,
    meetingId,
    createRecorder: (s, mimeType) => new MediaRecorder(s, { mimeType }) as unknown as RecorderLike,
    events: {
      onStarted: (sessionId) => emit({ target: 'background', type: 'REC_STARTED', sessionId }),
      onChunk: (seq) => emit({ target: 'background', type: 'REC_CHUNK', seq }),
      onStorage: (event) => emit({ target: 'background', type: 'REC_STORAGE', event }),
      onStopped: (chunkCount) => {
        cleanup();
        emit({ target: 'background', type: 'REC_STOPPED', chunkCount });
      },
      onError: (error) => {
        cleanup();
        emit({ target: 'background', type: 'REC_ERROR', error });
      },
    },
  });
  const sessionId = handle.sessionId;
  heartbeat = setInterval(
    () => emit({ target: 'background', type: 'REC_HEARTBEAT', sessionId }),
    HEARTBEAT_INTERVAL_MS,
  );
}

function cleanup() {
  handle = undefined;
  if (heartbeat) clearInterval(heartbeat);
  heartbeat = undefined;
  void audioCtx?.close();
  audioCtx = undefined;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Only the background service worker may drive the recorder (it is the one that checks
  // consent); the popup or any other extension page is ignored.
  if (!isOffscreenMessage(msg) || !isTrustedOffscreenSender(sender, extensionUrls())) return false;
  if (msg.type === 'OFFSCREEN_STOP') {
    if (!handle) {
      sendResponse({ ok: false, error: 'Not recording' });
      return false;
    }
    handle.stop();
    sendResponse({ ok: true });
    return false;
  }
  start(msg.streamId, msg.startedAt, msg.meetingId).then(
    () => sendResponse({ ok: true }),
    (err: unknown) => {
      const error = err instanceof Error ? err.message : String(err);
      cleanup();
      emit({ target: 'background', type: 'REC_ERROR', error });
      sendResponse({ ok: false, error });
    },
  );
  return true;
});
