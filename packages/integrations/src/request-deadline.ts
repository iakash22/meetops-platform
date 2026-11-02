/**
 * One deadline over a whole provider request: the fetch AND reading the body. `run` gets the AbortSignal to hand to
 * fetch. When the deadline passes, or the caller's `signal` aborts, the request is aborted and the call rejects with
 * `onTimeout()` even if `run` ignores the signal (a stalled body read can no longer hang the caller).
 */
export async function withRequestDeadline<T>(
  timeoutMs: number,
  signal: AbortSignal | undefined,
  onTimeout: () => Error,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let fire: (() => void) | undefined;
  const deadline = new Promise<never>((_, reject) => {
    fire = () => {
      controller.abort();
      reject(onTimeout());
    };
    timer = setTimeout(fire, timeoutMs);
    if (signal?.aborted) fire();
    else signal?.addEventListener('abort', fire, { once: true });
  });
  try {
    return await Promise.race([run(controller.signal), deadline]);
  } finally {
    clearTimeout(timer);
    if (fire) signal?.removeEventListener('abort', fire);
  }
}
