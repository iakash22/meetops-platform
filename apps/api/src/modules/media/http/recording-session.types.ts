import { Type, type Static } from '@sinclair/typebox';
import { Id, InitRecordingSessionRequest } from '@meetops/contracts';

/**
 * LOCAL (contract gap): contracts list the recording-session paths only in a doc comment, with no exported
 * RECORDING_SESSION_PATHS constant. The chunk/complete/abort paths carry no organizationId; the API resolves the org
 * from the caller's active organization.
 */
export const RECORDING_SESSION_PATHS = {
  init: '/orgs/:organizationId/recording-sessions',
  chunks: '/recording-sessions/:sessionId/chunks',
  complete: '/recording-sessions/:sessionId/complete',
  abort: '/recording-sessions/:sessionId/abort',
} as const;

export const SessionParams = Type.Object({ sessionId: Id }, { additionalProperties: false });
export type SessionParams = Static<typeof SessionParams>;

/** InitRecordingSessionRequest with `consent` loosened so a missing consent yields 422 CONSENT_REQUIRED, not 400. */
export const InitRecordingSessionRouteBody = Type.Object(
  {
    ...Type.Omit(InitRecordingSessionRequest, ['consent']).properties,
    consent: Type.Optional(Type.Unknown()),
  },
  { additionalProperties: false },
);
