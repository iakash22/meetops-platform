import { vi } from 'vitest';
import type { BackgroundDeps } from '../../src/lib/background-handler.js';
import { memoryKV } from '../../src/lib/storage.js';

export function makeDeps(kv = memoryKV()) {
  let t = 1000;
  const deps = {
    kv,
    now: () => t,
    ensureOffscreen: vi.fn(async () => undefined),
    closeOffscreen: vi.fn(async () => undefined),
    sendToOffscreen: vi.fn<(m: { type: string }) => Promise<{ ok: boolean }>>(async () => ({
      ok: true,
    })),
    hasOffscreen: vi.fn(async () => true),
    startWatchdog: vi.fn(async () => undefined),
    stopWatchdog: vi.fn(async () => undefined),
    finalizeAfterCrash: vi.fn(async () => undefined),
    capturedTabIds: vi.fn(async (): Promise<number[]> => [1, 2, 3, 7, 9]),
    setBadge: vi.fn(async () => undefined),
    durableKV: memoryKV(),
    discardLocal: vi.fn<(id: string) => Promise<void>>(async () => undefined),
  } satisfies BackgroundDeps;
  return { deps, advance: (ms: number) => (t += ms) };
}
