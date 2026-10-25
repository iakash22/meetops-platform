import { useEffect, useReducer, useState } from 'react';

import {
  elapsedMs,
  initialRecorderState,
  recorderReducer,
  type RecorderPhase,
} from './recorderShell';

export interface RecorderShell {
  phase: RecorderPhase;
  elapsedMs: number;
  start: () => void;
  pause: () => void;
  resume: () => void;
  stop: () => void;
  reset: () => void;
}

/** Ticks the timer from the wall clock (no drift from missed intervals). `now` is injectable for tests. */
export function useRecorderShell(now: () => number = Date.now, tickMs = 250): RecorderShell {
  const [state, dispatch] = useReducer(recorderReducer, initialRecorderState);
  const [clock, setClock] = useState(now);

  useEffect(() => {
    if (state.phase !== 'recording') return;
    setClock(now());
    const id = setInterval(() => setClock(now()), tickMs);
    return () => clearInterval(id);
  }, [state.phase, now, tickMs]);

  return {
    phase: state.phase,
    elapsedMs: elapsedMs(state, state.phase === 'recording' ? clock : 0),
    start: () => dispatch({ type: 'start', now: now() }),
    pause: () => dispatch({ type: 'pause', now: now() }),
    resume: () => dispatch({ type: 'resume', now: now() }),
    stop: () => dispatch({ type: 'stop', now: now() }),
    reset: () => dispatch({ type: 'reset' }),
  };
}
