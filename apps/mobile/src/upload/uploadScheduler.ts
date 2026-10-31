import type { FileChunkStore } from '../record/fileChunkStore';
import type { UploadQueueEngine } from './uploadQueueEngine';

/**
 * R4/R6 on relaunch: chunk folders with no queue entry (for example a crash between ingest and enqueue) are
 * deleted. Nothing is uploaded without its queue entry, because the consent attestation lives there.
 */
export async function reconcileOrphans(
  engine: Pick<UploadQueueEngine, 'items'>,
  store: Pick<FileChunkStore, 'list' | 'remove'> & Partial<Pick<FileChunkStore, 'held'>>,
): Promise<string[]> {
  // Held = sealed by crash recovery without a draft: kept encrypted (not an orphan) until enqueued or wiped.
  const held = (await store.held?.().catch(() => [])) ?? [];
  const known = new Set([...(await engine.items()).map((i) => i.id), ...held]);
  const orphans = (await store.list()).filter((id) => !known.has(id));
  for (const id of orphans) await store.remove(id);
  return orphans;
}

export interface AppStateLike {
  currentState: string;
  addEventListener(type: 'change', l: (s: string) => void): { remove(): void };
}

/** Connectivity changes (NetInfo). The engine itself skips passes while `isOnline()` is false. */
export interface NetworkChanges {
  onChange(listener: (online: boolean) => void): () => void;
}

/**
 * Runs queue passes at launch, whenever the app comes to the foreground and every `intervalMs` while it is in the
 * foreground (the engine's own backoff decides what is due). Uploads never run from a background trigger.
 * With `network`: offline passes do nothing (the engine checks `isOnline`), and coming back online while in the
 * foreground runs a pass right away instead of waiting for the next tick. Backoff still decides what is due.
 */
export function startUploadScheduler(
  engine: Pick<UploadQueueEngine, 'process'>,
  appState: AppStateLike,
  intervalMs = 60_000,
  network?: NetworkChanges,
): () => void {
  let timer: ReturnType<typeof setInterval> | null = null;
  let state = appState.currentState;
  const run = () => void engine.process().catch(() => undefined);
  const arm = (next: string) => {
    state = next;
    if (next === 'active') {
      run();
      timer ??= setInterval(run, intervalMs);
    } else if (timer) {
      clearInterval(timer);
      timer = null;
    }
  };
  arm(appState.currentState);
  const sub = appState.addEventListener('change', arm);
  const offNetwork = network?.onChange((online) => {
    if (online && state === 'active') run();
  });
  return () => {
    sub.remove();
    offNetwork?.();
    if (timer) clearInterval(timer);
  };
}
