import { Type, type Static } from '@sinclair/typebox';

/** All entity ids are UUIDs (ADR-004). */
export const Id = Type.String({ format: 'uuid' });
export type Id = Static<typeof Id>;
export const IsoDateTime = Type.String({ format: 'date-time' });
export type IsoDateTime = Static<typeof IsoDateTime>;
export const Timestamps = Type.Object({ createdAt: IsoDateTime, updatedAt: IsoDateTime });
