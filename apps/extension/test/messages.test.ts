import { describe, expect, it } from "vitest";
import { handleMessage, isPopupMessage, type RecorderState } from "../src/lib/messages";

const idle: RecorderState = { status: "idle" };
const start = { type: "START_RECORDING", tabId: 7, streamId: "s1", consentAcknowledgedAt: 1 };

describe("messages", () => {
  it("validates message shapes", () => {
    expect(isPopupMessage({ type: "GET_STATUS" })).toBe(true);
    expect(isPopupMessage(start)).toBe(true);
    expect(isPopupMessage({ ...start, streamId: "" })).toBe(false);
    expect(isPopupMessage({ type: "EVIL" })).toBe(false);
    expect(isPopupMessage(null)).toBe(false);
  });

  it("rejects malformed messages without changing state", () => {
    const r = handleMessage(idle, { type: "START_RECORDING" });
    expect(r.state).toBe(idle);
    expect(r.response.ok).toBe(false);
  });

  it("rejects start without consent timestamp", () => {
    const r = handleMessage(idle, { ...start, consentAcknowledgedAt: 0 });
    expect(r.response).toEqual({ ok: false, error: "Consent not acknowledged" });
  });

  it("starts, reports status, refuses double start, and stops", () => {
    const a = handleMessage(idle, start);
    expect(a.response).toEqual({ ok: true, status: "recording", tabId: 7 });
    expect(handleMessage(a.state, { type: "GET_STATUS" }).response).toEqual(a.response);
    expect(handleMessage(a.state, start).response.ok).toBe(false);
    const b = handleMessage(a.state, { type: "STOP_RECORDING" });
    expect(b.response).toEqual({ ok: true, status: "idle" });
  });
});
