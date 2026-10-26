import { InvalidCursorError, type Page } from './ports.js';

/**
 * Keyset cursor shared by the directory repositories: rows are ordered by (createdAt, id) ascending and the cursor
 * is the last row's key, `k:<epoch ms>:<id>` in base64url. Stable under concurrent inserts, unlike an offset.
 */
export interface CursorKey {
  createdAt: Date;
  id: string;
}

const CURSOR_RE = /^k:(\d{1,15}):([0-9a-zA-Z-]{1,64})$/;

export function encodeCursor(key: CursorKey): string {
  return Buffer.from(`k:${key.createdAt.getTime()}:${key.id}`, 'utf8').toString('base64url');
}

/** Throws InvalidCursorError for anything that is not a cursor this module issued. */
export function decodeCursor(cursor: string): CursorKey {
  const m = CURSOR_RE.exec(Buffer.from(cursor, 'base64url').toString('utf8'));
  if (!m?.[1] || !m[2]) throw new InvalidCursorError();
  return { createdAt: new Date(Number(m[1])), id: m[2] };
}

export const compareKeys = (a: CursorKey, b: CursorKey) =>
  a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** Pages an unordered in-memory list with the keyset cursor. `keyOf` gives each row's ordering key. */
export function keysetPage<T>(
  rows: T[],
  keyOf: (row: T) => CursorKey,
  q: { cursor?: string | undefined; limit: number },
): Page<T> {
  const after = q.cursor === undefined ? null : decodeCursor(q.cursor);
  const sorted = [...rows].sort((a, b) => compareKeys(keyOf(a), keyOf(b)));
  const rest = after ? sorted.filter((r) => compareKeys(keyOf(r), after) > 0) : sorted;
  const items = rest.slice(0, q.limit);
  const last = items[items.length - 1];
  return {
    items,
    nextCursor: rest.length > q.limit && last ? encodeCursor(keyOf(last)) : null,
  };
}
