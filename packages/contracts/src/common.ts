import { Type, type Static } from '@sinclair/typebox';

export const Id = Type.String({ minLength: 1, description: 'Opaque entity id (cuid/uuid)' });
export type Id = Static<typeof Id>;
export const IsoDateTime = Type.String({ format: 'date-time' });
export type IsoDateTime = Static<typeof IsoDateTime>;
export const Timestamps = Type.Object({ createdAt: IsoDateTime, updatedAt: IsoDateTime });
