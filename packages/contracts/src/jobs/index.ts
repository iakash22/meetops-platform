import { Type, type Static } from '@sinclair/typebox';
import { Id } from '../common.js';
import { MAX_CHUNKS } from '../api/recording-sessions.js';

/**
 * Queue names. Payloads are provider-independent: they carry router ids,
 * never SDK-specific config or credentials.
 */
export const QUEUE_NAMES = {
  transcription: 'transcription',
  ai: 'ai',
  email: 'email',
  media: 'media',
} as const;
export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

/** Known STT router ids. AssemblyAI is primary; faster-whisper is local; Deepgram optional. */
export const SttProviderId = Type.Union([
  Type.Literal('assemblyai'),
  Type.Literal('faster-whisper'),
  Type.Literal('deepgram'),
]);
export type SttProviderId = Static<typeof SttProviderId>;
export { STT_PROVIDER_IDS, TRANSCRIPT_PROVIDER_IDS } from '../constants.js';

/**
 * Provider recorded on a `Transcript`: every `SttProviderId` plus `'unknown'`.
 * `'unknown'` is for legacy rows backfilled by the DB migration only (ADR-004 addendum 2); new transcripts MUST record a
 * real `SttProviderId`. Never use this type for provider routing; use `SttProviderId`.
 */
export const TranscriptProviderId = Type.Union([...SttProviderId.anyOf, Type.Literal('unknown')]);
export type TranscriptProviderId = Static<typeof TranscriptProviderId>;

/** Known LLM provider ids. Gemini is primary; Ollama is local; OpenAI optional. */
export const LlmProviderId = Type.Union([
  Type.Literal('gemini'),
  Type.Literal('ollama'),
  Type.Literal('openai'),
]);
export type LlmProviderId = Static<typeof LlmProviderId>;

/** "<provider>:<model>", e.g. "gemini:gemini-2.5-flash-lite", "ollama:llama3.1". */
export const ModelRouteId = Type.String({ pattern: '^(gemini|ollama|openai):[A-Za-z0-9._\\-/]+$' });
export type ModelRouteId = Static<typeof ModelRouteId>;

/**
 * Fallback policy. There is NO automatic paid fallback: only routes listed
 * explicitly may be tried, and `allowPaidFallback` defaults to false.
 */
export const FallbackPolicy = Type.Object({
  fallbackRouteIds: Type.Array(ModelRouteId, { default: [] }),
  allowPaidFallback: Type.Boolean({ default: false }),
});
export type FallbackPolicy = Static<typeof FallbackPolicy>;

const JobMeta = {
  jobVersion: Type.Literal(1),
  organizationId: Id,
  requestId: Type.Optional(Type.String()),
  idempotencyKey: Type.String({ minLength: 1 }),
};

export const TranscriptionJobPayload = Type.Object({
  ...JobMeta,
  kind: Type.Literal('transcribe_recording'),
  meetingId: Id,
  recordingId: Id,
  fileObjectId: Id,
  sttProviderId: SttProviderId,
  languageHint: Type.Optional(Type.String()),
  /** Index of the normalized chunk this job transcribes. Omit for whole-file jobs. */
  chunkIndex: Type.Optional(Type.Integer({ minimum: 0, maximum: MAX_CHUNKS - 1 })),
  /** Offset of the chunk within the recording. Segment timestamps are shifted by this. 0 for whole-file jobs. */
  startMs: Type.Optional(Type.Integer({ minimum: 0 })),
  diarize: Type.Boolean({ default: true }),
  fallback: Type.Optional(FallbackPolicy),
}, { additionalProperties: false });
export type TranscriptionJobPayload = Static<typeof TranscriptionJobPayload>;

/** Media processing queue (normalize, chunk, then fan out transcription jobs). */
export const MEDIA_QUEUE = 'media' as const;
export const MEDIA_JOB_NAME = 'process_recording' as const;

export const MEDIA_SOURCE_EXTS = ['webm', 'ogg', 'mp3', 'm4a', 'mp4', 'wav'] as const;
export const MediaSourceExt = Type.Union(MEDIA_SOURCE_EXTS.map((e) => Type.Literal(e)));
export type MediaSourceExt = (typeof MEDIA_SOURCE_EXTS)[number];

export const MediaJobPayload = Type.Object(
  {
    jobVersion: Type.Literal(1),
    kind: Type.Literal('process_recording'),
    organizationId: Id,
    meetingId: Id,
    recordingId: Id,
    sourceExt: MediaSourceExt,
    /**
     * INTERNAL storage key of the uploaded source. Never expose it to clients. The worker must verify that it
     * matches the key derived from {organizationId, meetingId, recordingId, sourceExt}.
     */
    sourceKey: Type.Optional(Type.String({ minLength: 1, maxLength: 1024, pattern: '^[A-Za-z0-9!_.*()/-]+$' })),
    sttProviderId: Type.Optional(SttProviderId),
    languageHint: Type.Optional(Type.String({ maxLength: 35, pattern: '^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$' })),
    requestId: Type.Optional(Type.String({ minLength: 1, maxLength: 200, pattern: '^[A-Za-z0-9_-]+$' })),
  },
  { additionalProperties: false },
);
export type MediaJobPayload = Static<typeof MediaJobPayload>;

export const AiTaskKind = Type.Union([
  Type.Literal('summarize_meeting'),
  Type.Literal('extract_tasks'),
  Type.Literal('embed_transcript'),
]);
export type AiTaskKind = Static<typeof AiTaskKind>;

export const AiJobPayload = Type.Object({
  ...JobMeta,
  kind: AiTaskKind,
  meetingId: Id,
  transcriptId: Id,
  modelRouteId: ModelRouteId,
  promptVersion: Type.String(),
  fallback: Type.Optional(FallbackPolicy),
}, { additionalProperties: false });
export type AiJobPayload = Static<typeof AiJobPayload>;

/** Email queue name (matches @meetops/notifications). */
export const EMAIL_QUEUE = 'email' as const;
/** BullMQ retention for email jobs. */
export const EMAIL_JOB_RETENTION = {
  removeOnComplete: { count: 100, age: 3600 },
  removeOnFail: { count: 500, age: 86400 },
} as const;

export const EMAIL_TEMPLATE_IDS = [
  'verification',
  'password-reset',
  'invitation',
  'task-assigned',
  'meeting-summary',
] as const;
export const EmailTemplateId = Type.Union(EMAIL_TEMPLATE_IDS.map((t) => Type.Literal(t)));
export type EmailTemplateId = (typeof EMAIL_TEMPLATE_IDS)[number];

/** Opaque id: UUIDs also match. */
export const OPAQUE_ID_PATTERN = '^[A-Za-z0-9_-]+$';
const OpaqueId = Type.String({ minLength: 1, maxLength: 200, pattern: OPAQUE_ID_PATTERN });

export const EmailRecipientRef = Type.Union([
  Type.Object({ userId: Id }, { additionalProperties: false }),
  Type.Object({ invitationId: Id }, { additionalProperties: false }),
]);
export type EmailRecipientRef = Static<typeof EmailRecipientRef>;

const EmailUserRecipient = Type.Object({ userId: Id }, { additionalProperties: false });
const EmailInvitationRecipient = Type.Object({ invitationId: Id }, { additionalProperties: false });

const emailCommon = {
  jobVersion: Type.Literal(1),
  kind: Type.Literal('send_email'),
  organizationId: Id,
  idempotencyKey: OpaqueId,
  requestId: Type.Optional(OpaqueId),
  refs: Type.Optional(
    Type.Record(Type.String({ pattern: OPAQUE_ID_PATTERN, maxLength: 64 }), OpaqueId, {
      maxProperties: 10,
      additionalProperties: false,
    }),
  ),
  locale: Type.Optional(Type.String({ maxLength: 35, pattern: '^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$' })),
};

/**
 * Ids-only email job on queue `email` (INT, PR #11). It is a union of strict per-template objects:
 * `invitation` requires `recipient: { invitationId }`, and every other template requires `recipient: { userId }`.
 * It carries no addresses, names, URLs, tokens or template variables. The worker resolves the recipient, mints
 * one-time tokens and builds links server-side. Every level rejects unknown properties.
 */
export const EmailJobPayload = Type.Union([
  Type.Object(
    { ...emailCommon, templateId: Type.Literal('invitation'), recipient: EmailInvitationRecipient },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...emailCommon,
      templateId: Type.Union([
        Type.Literal('verification'),
        Type.Literal('password-reset'),
        Type.Literal('task-assigned'),
        Type.Literal('meeting-summary'),
      ]),
      recipient: EmailUserRecipient,
    },
    { additionalProperties: false },
  ),
]);
export type EmailJobPayload = Static<typeof EmailJobPayload>;
