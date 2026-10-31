import type { FileChunkStore } from '../record/fileChunkStore';
import type { UploadQueueEngine } from './uploadQueueEngine';

/**
 * R4/R6 on relaunch: chunk folders with no queue entry (for example a crash between ingest and enqueue) are
 * deleted. Nothing is uploaded without its queue entry, because the consent attestation lives there.
 */
export async function reconcileOrphans(
  engine: Pick<UploadQueueEngine, 'items'>,
  store: Pick<FileChunkStore, 'list' | 'remove'>,
): Promise<string[]> {
  const known = new Set((await engine.items()).map((i) => i.id));
  const orphans = (await store.list()).filter((id) => !known.has(id));
  for (const id of orphans) await store.remove(id);
  return orphans;
}

export interface AppStateLike {
  currentState: string;
  addEventListener(type: 'change', l: (s: string) => void): { remove(): void };
}

/**
 * Runs queue passes at launch, whenever the app comes to the foreground and every `intervalMs` while it is in the
 * foreground (the engine's own backoff decides what is due). Uploads never run from a background trigger.
 */
export function startUploadScheduler(
  engine: Pick<UploadQueueEngine, 'process'>,
  appState: AppStateLike,
  intervalMs = 60_000,
): () => void {
  let timer: ReturnType<typeof setInterval> | null = null;
  const run = () => void engine.process().catch(() => undefined);
  const arm = (state: string) => {
    if (state === 'active') {
      run();
      timer ??= setInterval(run, intervalMs);
    } else if (timer) {
      clearInterval(timer);
      timer = null;
    }
  };
  arm(appState.currentState);
  const sub = appState.addEventListener('change', arm);
  return () => {
    sub.remove();
    if (timer) clearInterval(timer);
  };
}
