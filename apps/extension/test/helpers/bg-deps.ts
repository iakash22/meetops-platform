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
    checkPairing: vi.fn(async () => true),
    storageQuota: vi.fn(async () => ({ usage: 0, quota: 10 * 1024 * 1024 * 1024 })),
    pendingStorage: vi.fn(async () => ({ pendingBytes: 0, capBytes: 500 * 1024 * 1024 })),
  } satisfies BackgroundDeps;
  return { deps, advance: (ms: number) => (t += ms) };
}
