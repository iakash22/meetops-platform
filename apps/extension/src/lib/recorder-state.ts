import type { KV } from "./storage.js";

export type RecorderState =
  | { status: "idle"; lastError?: string }
  | { status: "starting" | "recording" | "stopping"; tabId: number; sessionId: string; startedAt: number; chunks: number };

const KEY = "recorder";

export async function loadState(kv: KV): Promise<RecorderState> {
  return (await kv.get<RecorderState>(KEY)) ?? { status: "idle" };
}

export async function saveState(kv: KV, s: RecorderState): Promise<void> {
  await kv.set(KEY, s);
}
