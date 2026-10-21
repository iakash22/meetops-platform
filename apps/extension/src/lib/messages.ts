/** Messaging contract between popup and background service worker. */
export type RecordingStatus = "idle" | "recording";

export type PopupToBackground =
  | { type: "GET_STATUS" }
  | { type: "START_RECORDING"; tabId: number; streamId: string; consentAcknowledgedAt: number }
  | { type: "STOP_RECORDING" };

export type BackgroundResponse =
  | { ok: true; status: RecordingStatus; tabId?: number }
  | { ok: false; error: string };

export interface RecorderState {
  status: RecordingStatus;
  tabId?: number;
  streamId?: string;
}

export function isPopupMessage(msg: unknown): msg is PopupToBackground {
  if (typeof msg !== "object" || msg === null) return false;
  const m = msg as Record<string, unknown>;
  switch (m.type) {
    case "GET_STATUS":
    case "STOP_RECORDING":
      return true;
    case "START_RECORDING":
      return (
        typeof m.tabId === "number" &&
        typeof m.streamId === "string" &&
        m.streamId.length > 0 &&
        typeof m.consentAcknowledgedAt === "number"
      );
    default:
      return false;
  }
}

/** Pure reducer used by the background worker; returns new state + response. */
export function handleMessage(
  state: RecorderState,
  msg: unknown
): { state: RecorderState; response: BackgroundResponse } {
  if (!isPopupMessage(msg)) {
    return { state, response: { ok: false, error: "Unknown or malformed message" } };
  }
  switch (msg.type) {
    case "GET_STATUS":
      return { state, response: statusResponse(state) };
    case "START_RECORDING": {
      if (state.status === "recording") {
        return { state, response: { ok: false, error: "Already recording" } };
      }
      if (!(msg.consentAcknowledgedAt > 0)) {
        return { state, response: { ok: false, error: "Consent not acknowledged" } };
      }
      const next: RecorderState = { status: "recording", tabId: msg.tabId, streamId: msg.streamId };
      return { state: next, response: statusResponse(next) };
    }
    case "STOP_RECORDING": {
      const next: RecorderState = { status: "idle" };
      return { state: next, response: statusResponse(next) };
    }
  }
}

function statusResponse(state: RecorderState): BackgroundResponse {
  return state.tabId === undefined
    ? { ok: true, status: state.status }
    : { ok: true, status: state.status, tabId: state.tabId };
}
