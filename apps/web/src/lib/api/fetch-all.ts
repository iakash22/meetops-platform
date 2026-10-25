import { MAX_PAGE_LIMIT } from '@meetops/contracts/types';
import type { CursorParams } from './client';

/** Safety cap: at most this many pages are read for one list (MAX_PAGE_LIMIT items each). */
export const MAX_PAGES = 20;

/**
 * Read a cursor-paged list endpoint to the end (or MAX_PAGES), returning every item.
 * `truncated` is true when the cap stopped the walk before `nextCursor` was null.
 */
export async function fetchAllPages<T>(
  load: (page: CursorParams) => Promise<{ items: T[]; nextCursor: string | null }>,
): Promise<{ items: T[]; truncated: boolean }> {
  const items: T[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < MAX_PAGES; i++) {
    const page = await load({ limit: MAX_PAGE_LIMIT, ...(cursor ? { cursor } : {}) });
    items.push(...page.items);
    if (!page.nextCursor) return { items, truncated: false };
    cursor = page.nextCursor;
  }
  return { items, truncated: true };
}
