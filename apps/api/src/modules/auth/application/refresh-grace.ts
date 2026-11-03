/** Server-side grace window for rotating refresh tokens (extension and desktop auth). */
export const REFRESH_GRACE_WINDOW_MS = 10_000;

type Entry<T> = { tokenHash: string; deviceId: string; at: number; pair: Promise<T> };

/**
 * Remembers, per token family, the refresh token most recently consumed and the pair it was rotated into. Presenting
 * that same token again from the same device within the window (a lost response, two tabs racing) gets the same new
 * pair back instead of tripping reuse detection. Anything older, from another device, or outside the window is still
 * treated as reuse. In-process only: a retry that lands on another API instance falls back to revocation (fail
 * closed). Bounded: the oldest families are evicted beyond `maxFamilies`.
 */
export class RefreshGraceCache<T> {
  private readonly entries = new Map<string, Entry<T>>();
  constructor(
    private readonly windowMs = REFRESH_GRACE_WINDOW_MS,
    private readonly maxFamilies = 10_000,
  ) {}

  /** Record a rotation that is starting; settle it with the issued pair (or a failure). */
  begin(
    familyId: string,
    tokenHash: string,
    deviceId: string,
    at: number,
  ): { resolve(pair: T): void; reject(): void } {
    let resolve!: (pair: T) => void;
    let reject!: (err: Error) => void;
    const pair = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    pair.catch(() => undefined);
    this.entries.delete(familyId);
    while (this.entries.size >= this.maxFamilies)
      this.entries.delete(this.entries.keys().next().value as string);
    const entry: Entry<T> = { tokenHash, deviceId, at, pair };
    this.entries.set(familyId, entry);
    return {
      resolve,
      reject: () => {
        if (this.entries.get(familyId) === entry) this.entries.delete(familyId);
        reject(new Error('refresh failed'));
      },
    };
  }

  /** The pair to return again, or undefined when this is real reuse. */
  replay(
    familyId: string,
    tokenHash: string,
    deviceId: string,
    now: number,
  ): Promise<T> | undefined {
    const e = this.entries.get(familyId);
    if (!e || e.tokenHash !== tokenHash || e.deviceId !== deviceId) return undefined;
    if (now - e.at > this.windowMs || now < e.at) return undefined;
    return e.pair;
  }

  forget(familyId: string): void {
    this.entries.delete(familyId);
  }
}
