import { Type, type Static } from '@sinclair/typebox';
import { ApiErrorCode as ContractErrorCode } from '@meetops/contracts';

/**
 * Contracts ApiErrorCode plus 'CSRF_INVALID'.
 * TODO(contracts #50): switch to @meetops/contracts once PR #50 (adds CSRF_INVALID) merges, then delete this file.
 */
export const ApiErrorCode = Type.Union([...ContractErrorCode.anyOf, Type.Literal('CSRF_INVALID')]);
export type ApiErrorCode = Static<typeof ApiErrorCode>;

export const ApiErrorEnvelope = Type.Object({
  error: Type.Object({
    code: ApiErrorCode,
    message: Type.String({ maxLength: 500 }),
    requestId: Type.String({ minLength: 1 }),
    details: Type.Optional(Type.Array(Type.Object({ path: Type.String(), message: Type.String({ maxLength: 500 }) })))
  })
});
export type ApiErrorEnvelope = Static<typeof ApiErrorEnvelope>;
