import type { KV } from './storage.js';

/**
 * Sessions that must be thrown away (captured-tab mismatch) but whose local data may still exist.
 * Kept in a persistent KV (chrome.storage.local in production), not storage.session: IndexedDB
 * chunks survive a browser restart, so the marker must too, or a later drain could upload them.
 *
 * Stored shape: `PendingDiscard[]`. Legacy entries (bare session-id strings) are accepted and
 * upgraded. Anything else is treated as corrupt: a non-array becomes [], invalid entries are
 * dropped, and the cleaned list is written back. Reading never throws.
 */
const KEY = 'pendingDiscards';

/** Discard attempts (via discardLocal) before falling back to a direct local delete. */
export const MAX_DISCARD_ATTEMPTS = 3;

export interface PendingDiscard {
  sessionId: string;
  attempts: number;
  /** Discard and the direct-delete fallback both failed: never retried, never uploaded. */
  failed?: true;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isSessionId = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);

function normalize(raw: unknown): PendingDiscard[] {
  if (!Array.isArray(raw)) return [];
  const out: PendingDiscard[] = [];
  for (const e of raw as unknown[]) {
    let entry: PendingDiscard | undefined;
    if (isSessionId(e)) entry = { sessionId: e, attempts: 0 };
    else if (e && typeof e === 'object' && isSessionId((e as PendingDiscard).sessionId)) {
      const { sessionId, attempts, failed } = e as PendingDiscard;
      const n = Number.isInteger(attempts) && attempts >= 0 ? attempts : 0;
      entry = {
        sessionId,
        attempts: Math.min(n, MAX_DISCARD_ATTEMPTS),
        ...(failed === true ? { failed: true as const } : {}),
      };
    }
    if (entry && !out.some((x) => x.sessionId === entry.sessionId)) out.push(entry);
  }
  return out;
}

async function save(kv: KV, entries: PendingDiscard[]): Promise<void> {
  if (entries.length) await kv.set(KEY, entries);
  else await kv.remove(KEY);
}

// Single module-level serial queue: every read-modify-write of the pendingDiscards list (and the
// corrupt/legacy rewrite on read) runs here one at a time, across all sessions, so a retry that
// clears session A can never overwrite a marker added for session B in the meantime.
let listQueue: Promise<unknown> = Promise.resolve();
function withListQueue<T>(fn: () => Promise<T>): Promise<T> {
  const run = listQueue.then(fn, fn);
  listQueue = run.catch(() => undefined);
  return run;
}

/** Validated marker entries; rewrites the stored value if it was corrupt or legacy. */
export function readPendingDiscards(kv: KV): Promise<PendingDiscard[]> {
  return withListQueue(() => readUnqueued(kv));
}

async function readUnqueued(kv: KV): Promise<PendingDiscard[]> {
  let raw: unknown;
  try {
    raw = await kv.get<unknown>(KEY);
  } catch (err) {
    console.warn('MeetOps AI: reading pending discards failed', err);
    return [];
  }
  if (raw === undefined) return [];
  const clean = normalize(raw);
  if (JSON.stringify(clean) !== JSON.stringify(raw)) {
    await save(kv, clean).catch((err: unknown) =>
      console.warn('MeetOps AI: rewriting pending discards failed', err),
    );
  }
  return clean;
}

/** Every marked session id (including permanently failed ones: those must never be uploaded). */
export async function listPendingDiscards(kv: KV): Promise<string[]> {
  return (await readPendingDiscards(kv)).map((e) => e.sessionId);
}

export async function isPendingDiscard(kv: KV, sessionId: string): Promise<boolean> {
  return (await listPendingDiscards(kv)).includes(sessionId);
}

export async function listFailedDiscards(kv: KV): Promise<string[]> {
  return (await readPendingDiscards(kv)).filter((e) => e.failed).map((e) => e.sessionId);
}

// Per-session gate shared by marking and by the drain's check-then-PUT, so a mark can never land
// between the drain's marker check and its PUT: marking waits for an in-flight PUT of that
// session (and only that session) to finish, and every later PUT sees the mark.
const gates = new Map<string, Promise<unknown>>();
export function withSessionGate<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
  const prev = gates.get(sessionId) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.catch(() => undefined);
  gates.set(sessionId, tail);
  void tail.then(() => {
    if (gates.get(sessionId) === tail) gates.delete(sessionId);
  });
  return run;
}

export async function addPendingDiscard(kv: KV, sessionId: string): Promise<void> {
  // Per-session gate (ordering against that session's PUTs), then the shared list queue.
  await withSessionGate(sessionId, () =>
    withListQueue(async () => {
      const entries = await readUnqueued(kv);
      if (!entries.some((e) => e.sessionId === sessionId)) {
        await save(kv, [...entries, { sessionId, attempts: 0 }]);
      }
    }),
  );
}

export async function clearPendingDiscard(kv: KV, sessionId: string): Promise<void> {
  await withListQueue(async () =>
    save(
      kv,
      (await readUnqueued(kv)).filter((e) => e.sessionId !== sessionId),
    ),
  );
}

async function update(kv: KV, sessionId: string, patch: Partial<PendingDiscard>): Promise<void> {
  await withListQueue(async () =>
    save(
      kv,
      (await readUnqueued(kv)).map((e) => (e.sessionId === sessionId ? { ...e, ...patch } : e)),
    ),
  );
}

/**
 * Retry every pending (not failed) discard. `discardLocal` deletes the session and its chunks and
 * aborts the upload session (consent_revoked). A marker is cleared only after success. Each
 * failure counts an attempt; at MAX_DISCARD_ATTEMPTS the direct `deleteLocal` fallback runs, and
 * if that fails too the entry is marked failed and never retried (it still blocks uploads).
 * One session's failure never stops the others. Returns the ids still marked.
 */
export async function retryPendingDiscards(
  kv: KV,
  discardLocal: (sessionId: string) => Promise<void>,
  deleteLocal?: (sessionId: string) => Promise<void>,
  abortRemote?: (sessionId: string) => Promise<void>,
): Promise<string[]> {
  for (const e of await readPendingDiscards(kv)) {
    if (e.failed) continue;
    try {
      try {
        await discardLocal(e.sessionId);
      } catch (err) {
        const attempts = e.attempts + 1;
        if (attempts < MAX_DISCARD_ATTEMPTS) {
          console.warn('MeetOps AI: discarding session failed; will retry', e.sessionId, err);
          await update(kv, e.sessionId, { attempts });
          continue;
        }
        try {
          if (!deleteLocal) throw err;
          // Best-effort server abort first: the fallback deletes local data only.
          await abortRemote?.(e.sessionId).catch(() => undefined);
          await deleteLocal(e.sessionId);
        } catch (fallbackErr) {
          console.error('MeetOps AI: discard gave up', e.sessionId, fallbackErr);
          await update(kv, e.sessionId, { attempts, failed: true });
          continue;
        }
      }
      await clearPendingDiscard(kv, e.sessionId);
    } catch (err) {
      console.warn('MeetOps AI: updating pending discard failed', e.sessionId, err);
    }
  }
  return listPendingDiscards(kv);
}

export const DISCARD_FAILED_MESSAGE =
  'A discarded recording could not be deleted from local storage. It will not be uploaded; clear the extension data or reinstall to remove it.';
