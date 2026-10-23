import { Type, type Static, type TSchema } from '@sinclair/typebox';

/** Max page size; matches the `limit` maximum of CursorPageQuery and OffsetPageQuery. */
export const MAX_PAGE_LIMIT = 100;
/** Max length of an opaque cursor. */
export const MAX_CURSOR_LENGTH = 512;

export const CursorPageQuery = Type.Object({
  cursor: Type.Optional(Type.String()),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_PAGE_LIMIT, default: 25 })),
}, { additionalProperties: false });
export type CursorPageQuery = Static<typeof CursorPageQuery>;

export const OffsetPageQuery = Type.Object({
  offset: Type.Optional(Type.Integer({ minimum: 0, default: 0 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_PAGE_LIMIT, default: 25 })),
}, { additionalProperties: false });
export type OffsetPageQuery = Static<typeof OffsetPageQuery>;

/** A page holds at most MAX_PAGE_LIMIT items; `nextCursor` is at most MAX_CURSOR_LENGTH characters, or null on the last page. */
export const CursorPage = <T extends TSchema>(item: T) =>
  Type.Object({
    items: Type.Array(item, { maxItems: MAX_PAGE_LIMIT }),
    nextCursor: Type.Union([Type.String({ maxLength: MAX_CURSOR_LENGTH }), Type.Null()]),
  });
export type CursorPage<T> = { items: T[]; nextCursor: string | null };

export const OffsetPage = <T extends TSchema>(item: T) =>
  Type.Object({
    items: Type.Array(item),
    total: Type.Integer({ minimum: 0 }),
    offset: Type.Integer({ minimum: 0 }),
    limit: Type.Integer({ minimum: 1 }),
  });
export type OffsetPage<T> = { items: T[]; total: number; offset: number; limit: number };

/** Default list response used by the web app: cursor-based. Alias of CursorPage. */
export const Paginated = CursorPage;
export type Paginated<T> = CursorPage<T>;
