/** Messaging contracts between popup, background service worker and offscreen document. */

/** popup -> background */
export type PopupToBackground =
  | { target: "background"; type: "GET_STATUS" }
  | { target: "background"; type: "ACK_CONSENT"; tabId: number }
  | { target: "background"; type: "START_RECORDING"; tabId: number; streamId: string }
  | { target: "background"; type: "STOP_RECORDING" };

/** background -> offscreen */
export type BackgroundToOffscreen =
  | { target: "offscreen"; type: "OFFSCREEN_START"; streamId: string; startedAt: number }
  | { target: "offscreen"; type: "OFFSCREEN_STOP" };

/** offscreen -> background (events) */
export type OffscreenToBackground =
  | { target: "background"; type: "REC_STARTED"; sessionId: string }
  | { target: "background"; type: "REC_CHUNK"; seq: number }
  | { target: "background"; type: "REC_STOPPED"; chunkCount: number }
  | { target: "background"; type: "REC_ERROR"; error: string };

export type BackgroundMessage = PopupToBackground | OffscreenToBackground;

export interface StatusPayload {
  status: "idle" | "starting" | "recording" | "stopping";
  tabId?: number;
  startedAt?: number;
  chunks?: number;
  lastError?: string;
}

export type BackgroundResponse = ({ ok: true } & StatusPayload) | { ok: false; error: string };

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;
const isStr = (v: unknown): v is string => typeof v === "string" && v.length > 0;

export function isBackgroundMessage(msg: unknown): msg is BackgroundMessage {
  if (typeof msg !== "object" || msg === null) return false;
  const m = msg as Record<string, unknown>;
  if (m.target !== "background") return false;
  switch (m.type) {
    case "GET_STATUS":
    case "STOP_RECORDING":
      return true;
    case "ACK_CONSENT":
      return isNum(m.tabId);
    case "START_RECORDING":
      return isNum(m.tabId) && isStr(m.streamId);
    case "REC_STARTED":
      return isStr(m.sessionId);
    case "REC_CHUNK":
      return isNum(m.seq);
    case "REC_STOPPED":
      return isNum(m.chunkCount);
    case "REC_ERROR":
      return typeof m.error === "string";
    default:
      return false;
  }
}

export function isOffscreenMessage(msg: unknown): msg is BackgroundToOffscreen {
  if (typeof msg !== "object" || msg === null) return false;
  const m = msg as Record<string, unknown>;
  if (m.target !== "offscreen") return false;
  if (m.type === "OFFSCREEN_STOP") return true;
  return m.type === "OFFSCREEN_START" && isStr(m.streamId) && isNum(m.startedAt);
}
