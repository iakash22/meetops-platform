import { DomainError } from './domain-error.js';

const DEFAULT_LIMIT = 25;

/**
 * Opaque cursor paging over an already-ordered, in-memory list (session, org and member lists are small and
 * fully loaded). The cursor encodes the next offset; a malformed cursor is a 400.
 */
export function paginate<T>(all: T[], q: { cursor?: string; limit?: number } = {}): { items: T[]; nextCursor: string | null } {
  const limit = q.limit ?? DEFAULT_LIMIT;
  let offset = 0;
  if (q.cursor !== undefined) {
    const m = /^o:(\d{1,9})$/.exec(Buffer.from(q.cursor, 'base64url').toString('utf8'));
    if (!m) throw new DomainError('BAD_REQUEST', 'Invalid cursor', 400);
    offset = Number(m[1]);
  }
  const items = all.slice(offset, offset + limit);
  const next = offset + limit;
  return { items, nextCursor: next < all.length ? Buffer.from(`o:${next}`).toString('base64url') : null };
}
