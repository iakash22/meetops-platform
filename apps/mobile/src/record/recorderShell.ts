/**
 * Preview-only recorder state machine for the Record tab. It drives the UI (button, timer, status)
 * but captures NO audio: there are no native recording dependencies yet (RECORDING_ENABLED=false).
 * The real recorder will implement the same transitions behind consent and the upload queue.
 *
 *   idle --start--> recording --pause--> paused --resume--> recording
 *   recording|paused --stop--> stopped --reset--> idle
 */
export type RecorderPhase = 'idle' | 'recording' | 'paused' | 'stopped';

export interface RecorderState {
  phase: RecorderPhase;
  /** Time recorded before the current run (ms). */
  accumulatedMs: number;
  /** Clock time the current run started, when recording. */
  startedAt: number | null;
}

export type RecorderAction =
  | { type: 'start'; now: number }
  | { type: 'pause'; now: number }
  | { type: 'resume'; now: number }
  | { type: 'stop'; now: number }
  | { type: 'reset' };

export const initialRecorderState: RecorderState = {
  phase: 'idle',
  accumulatedMs: 0,
  startedAt: null,
};

export function elapsedMs(state: RecorderState, now: number): number {
  const running =
    state.phase === 'recording' && state.startedAt !== null ? now - state.startedAt : 0;
  return state.accumulatedMs + Math.max(0, running);
}

/** Pure reducer. Invalid transitions return the same state object. */
export function recorderReducer(state: RecorderState, action: RecorderAction): RecorderState {
  switch (action.type) {
    case 'start':
      return state.phase === 'idle'
        ? { phase: 'recording', accumulatedMs: 0, startedAt: action.now }
        : state;
    case 'pause':
      return state.phase === 'recording'
        ? { phase: 'paused', accumulatedMs: elapsedMs(state, action.now), startedAt: null }
        : state;
    case 'resume':
      return state.phase === 'paused'
        ? { ...state, phase: 'recording', startedAt: action.now }
        : state;
    case 'stop':
      return state.phase === 'recording' || state.phase === 'paused'
        ? { phase: 'stopped', accumulatedMs: elapsedMs(state, action.now), startedAt: null }
        : state;
    case 'reset':
      return state.phase === 'stopped' ? initialRecorderState : state;
  }
}

/** "MM:SS", or "H:MM:SS" from one hour. */
export function formatElapsed(ms: number): string {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** Screen-reader form, e.g. "1 minute 5 seconds". */
export function spokenElapsed(ms: number): string {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const part = (n: number, unit: string) => `${n} ${unit}${n === 1 ? '' : 's'}`;
  const parts = [
    h > 0 ? part(h, 'hour') : null,
    h > 0 || m > 0 ? part(m, 'minute') : null,
    part(s, 'second'),
  ];
  return parts.filter(Boolean).join(' ');
}
