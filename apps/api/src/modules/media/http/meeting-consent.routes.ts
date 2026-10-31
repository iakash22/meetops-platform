import type { FastifyInstance } from 'fastify';
import { Type, type Static } from '@sinclair/typebox';
import {
  Id,
  MEETING_CONSENT_PATHS,
  MeetingConsentEvent,
  MeetingConsentStatus,
  RevokeMeetingConsentRequest,
} from '@meetops/contracts';
import { ErrorBody } from '../../auth/http/schemas.js';
import { directoryErrors, type ResolveCaller } from '../../directory/http/route-kit.js';
import { toWire, type MeetingConsentService } from '../application/meeting-consent.service.js';

const tags = ['consent'];
const errors = { ...directoryErrors, 422: ErrorBody } as const;

const MeetingConsentParams = Type.Object(
  { organizationId: Id, meetingId: Id },
  { additionalProperties: false },
);
type MeetingConsentParams = Static<typeof MeetingConsentParams>;

/**
 * Consent API (append-only meeting consent ledger). Org-scoped: a path org that is not the caller's active org, or a
 * meeting of another org, is 404. The record body is loosened to `unknown` so a missing/invalid consent gets the
 * contract's 422 CONSENT_* (like upload / recording-session init) instead of a generic 400.
 */
export async function meetingConsentRoutes(
  app: FastifyInstance,
  opts: { consents: MeetingConsentService; caller: ResolveCaller; writeCaller: ResolveCaller },
) {
  const { consents, caller, writeCaller } = opts;

  app.get<{ Params: MeetingConsentParams }>(
    MEETING_CONSENT_PATHS.consent,
    {
      schema: {
        tags,
        summary: 'Recording consent status of a meeting',
        params: MeetingConsentParams,
        response: { 200: MeetingConsentStatus, ...errors },
      },
    },
    async (request, reply) => {
      const c = await caller(request, request.params.organizationId);
      const status = await consents.status(c, request.params.meetingId);
      return reply.header('cache-control', 'no-store').send(status);
    },
  );

  app.post<{ Params: MeetingConsentParams; Body: unknown }>(
    MEETING_CONSENT_PATHS.consent,
    {
      schema: {
        tags,
        summary: 'Record recording consent for a meeting',
        description:
          'RecordMeetingConsentRequest. Appends a `granted` event. Missing/invalid consent -> 422 VALIDATION_FAILED + CONSENT_*.',
        params: MeetingConsentParams,
        response: { 201: MeetingConsentEvent, ...errors },
      },
    },
    async (request, reply) => {
      const c = await writeCaller(request, request.params.organizationId);
      const e = await consents.record(c, request.params.meetingId, request.body);
      return reply.code(201).send(toWire(e));
    },
  );

  app.post<{ Params: MeetingConsentParams; Body: RevokeMeetingConsentRequest }>(
    MEETING_CONSENT_PATHS.revoke,
    {
      schema: {
        tags,
        summary: 'Revoke recording consent for a meeting',
        description:
          'Appends a `revoked` event; earlier grants stay as evidence. Nothing is deleted.',
        params: MeetingConsentParams,
        body: RevokeMeetingConsentRequest,
        response: { 201: MeetingConsentEvent, ...errors },
      },
    },
    async (request, reply) => {
      const c = await writeCaller(request, request.params.organizationId);
      const e = await consents.revoke(c, request.params.meetingId, request.body ?? {});
      return reply.code(201).send(toWire(e));
    },
  );
}
