import { Type, type Static, type TSchema } from '@sinclair/typebox';

export const CursorPageQuery = Type.Object({
  cursor: Type.Optional(Type.String()),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 25 })),
});
export type CursorPageQuery = Static<typeof CursorPageQuery>;

export const OffsetPageQuery = Type.Object({
  offset: Type.Optional(Type.Integer({ minimum: 0, default: 0 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 25 })),
});
export type OffsetPageQuery = Static<typeof OffsetPageQuery>;

export const CursorPage = <T extends TSchema>(item: T) =>
  Type.Object({
    items: Type.Array(item),
    nextCursor: Type.Union([Type.String(), Type.Null()]),
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
