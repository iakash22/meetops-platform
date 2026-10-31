import { useSyncExternalStore } from 'react';

import type { RecorderPhase } from './recorderShell';

/**
 * App-wide recording indicator (R2): the Record tab publishes its phase here and the signed-in layout shows a
 * persistent banner on every screen while a capture is recording or paused.
 */
let phase: RecorderPhase = 'idle';
const listeners = new Set<() => void>();

export function setRecordingPhase(next: RecorderPhase): void {
  if (next === phase) return;
  phase = next;
  listeners.forEach((l) => l());
}

export function getRecordingPhase(): RecorderPhase {
  return phase;
}

export function useRecordingPhase(): RecorderPhase {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    getRecordingPhase,
    getRecordingPhase,
  );
}
