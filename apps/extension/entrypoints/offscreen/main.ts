/// <reference types="chrome" />
import { isOffscreenMessage, type OffscreenToBackground } from "../../src/lib/messages.js";
import { startRecording, type RecorderLike, type RecordingHandle } from "../../src/lib/recorder.js";
import { StubUploadClient } from "../../src/lib/upload.js";

// TODO: swap for the real HTTP client once the chunked upload API exists.
const client = new StubUploadClient();
let handle: RecordingHandle | undefined;
let audioCtx: AudioContext | undefined;

const emit = (msg: OffscreenToBackground) => {
  void chrome.runtime.sendMessage(msg).catch(() => undefined);
};

async function start(streamId: string, startedAt: number) {
  if (handle) throw new Error("Already recording");
  const constraints = {
    audio: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: streamId } },
    video: false
  } as unknown as MediaStreamConstraints;
  const stream = await navigator.mediaDevices.getUserMedia(constraints);
  // Tab capture mutes the tab by default; route audio back so the user still hears the meeting.
  audioCtx = new AudioContext();
  audioCtx.createMediaStreamSource(stream).connect(audioCtx.destination);
  handle = await startRecording({
    stream,
    client,
    startedAt,
    createRecorder: (s, mimeType) => new MediaRecorder(s, { mimeType }) as unknown as RecorderLike,
    events: {
      onStarted: (sessionId) => emit({ target: "background", type: "REC_STARTED", sessionId }),
      onChunk: (seq) => emit({ target: "background", type: "REC_CHUNK", seq }),
      onStopped: (chunkCount) => {
        cleanup();
        emit({ target: "background", type: "REC_STOPPED", chunkCount });
      },
      onError: (error) => {
        cleanup();
        emit({ target: "background", type: "REC_ERROR", error });
      }
    }
  });
}

function cleanup() {
  handle = undefined;
  void audioCtx?.close();
  audioCtx = undefined;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || !isOffscreenMessage(msg)) return false;
  if (msg.type === "OFFSCREEN_STOP") {
    if (!handle) {
      sendResponse({ ok: false, error: "Not recording" });
      return false;
    }
    handle.stop();
    sendResponse({ ok: true });
    return false;
  }
  start(msg.streamId, msg.startedAt).then(
    () => sendResponse({ ok: true }),
    (err: unknown) => {
      const error = err instanceof Error ? err.message : String(err);
      cleanup();
      emit({ target: "background", type: "REC_ERROR", error });
      sendResponse({ ok: false, error });
    }
  );
  return true;
});
