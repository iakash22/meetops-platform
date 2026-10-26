import type { FastifyRequest } from 'fastify';
import { ErrorBody } from '../../auth/http/schemas.js';
import type { DirectoryCaller } from '../access.js';

/** Resolves the tenant caller for a route: session (401), active-org membership (404), never from input. */
export type ResolveCaller = (
  request: FastifyRequest,
  organizationId: string,
) => Promise<DirectoryCaller>;

/** Error responses every directory route can return. */
export const directoryErrors = {
  400: ErrorBody,
  401: ErrorBody,
  403: ErrorBody,
  404: ErrorBody,
  429: ErrorBody,
} as const;
export const directoryWriteErrors = { ...directoryErrors, 409: ErrorBody } as const;

export const iso = (d: Date) => d.toISOString();
