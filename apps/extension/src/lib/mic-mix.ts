/**
 * Tab + microphone mix for the offscreen recorder, and the popup-only mic
 * permission request. The offscreen document must never be the first prompt:
 * call `requestMicPermission` from the popup click, then pass `includeMic`.
 */

export const MIC_CONSTRAINTS: MediaTrackConstraints = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
};

export const MIC_UNAVAILABLE_MESSAGE = "Your microphone isn't being recorded";

export type MicPermissionResult = 'granted' | 'denied';

export type GetUserMedia = (constraints: MediaStreamConstraints) => Promise<MediaStream>;

/** Minimal AudioContext surface the mix graph uses (injectable in tests). */
export interface MixAudioContext {
  destination: { connect?: unknown };
  createMediaStreamSource(stream: MediaStream): MixAudioNode;
  createMediaStreamDestination(): MixAudioDestination;
}

export interface MixAudioNode {
  connect(dest: unknown): unknown;
}

export interface MixAudioDestination extends MixAudioNode {
  stream: MediaStream;
}

export interface CaptureGraph {
  /** Mixed stream (tab, plus mic when present) for MediaRecorder. */
  recorded: MediaStream;
  /** True when a mic source was connected to the mix, not to the speakers. */
  micMixed: boolean;
  stopInputTracks: () => void;
}

function stopTracks(stream: MediaStream): void {
  for (const t of stream.getTracks()) {
    try {
      t.stop();
    } catch {
      // keep stopping the rest
    }
  }
}

/**
 * Ask for the microphone from a visible extension page (the popup) during a
 * user gesture. Stops the resulting tracks immediately: we only need the
 * permission grant so the offscreen document can open its own stream later
 * without prompting.
 */
export async function requestMicPermission(
  getUserMedia: GetUserMedia,
): Promise<MicPermissionResult> {
  try {
    const stream = await getUserMedia({ audio: MIC_CONSTRAINTS, video: false });
    stopTracks(stream);
    return 'granted';
  } catch {
    return 'denied';
  }
}

/**
 * Open a mic stream after the popup has already requested permission.
 * Returns null when the device is unavailable or the grant did not stick
 * (the caller then falls back to tab-only).
 */
export async function acquireMicStream(getUserMedia: GetUserMedia): Promise<MediaStream | null> {
  try {
    return await getUserMedia({ audio: MIC_CONSTRAINTS, video: false });
  } catch {
    return null;
  }
}

/**
 * Route tab audio to the speakers (so tabCapture does not silence the meeting)
 * and mix tab + optional mic into a destination stream for MediaRecorder.
 * The mic is never connected to `ctx.destination`.
 */
export function connectCaptureGraph(
  ctx: MixAudioContext,
  tabStream: MediaStream,
  micStream: MediaStream | null,
): CaptureGraph {
  const tabSource = ctx.createMediaStreamSource(tabStream);
  tabSource.connect(ctx.destination);
  const mixDest = ctx.createMediaStreamDestination();
  tabSource.connect(mixDest);
  if (micStream) {
    ctx.createMediaStreamSource(micStream).connect(mixDest);
  }
  return {
    recorded: mixDest.stream,
    micMixed: micStream !== null,
    stopInputTracks: () => {
      stopTracks(tabStream);
      if (micStream) stopTracks(micStream);
    },
  };
}

export function isTabCaptureConstraints(constraints: MediaStreamConstraints): boolean {
  const audio = constraints.audio;
  if (!audio || typeof audio !== 'object') return false;
  const mandatory = (audio as { mandatory?: { chromeMediaSource?: string } }).mandatory;
  return mandatory?.chromeMediaSource === 'tab' && constraints.video === false;
}
