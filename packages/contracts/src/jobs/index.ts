import { Type, type Static } from '@sinclair/typebox';
import { Id } from '../common.js';

/**
 * Queue names. Payloads are provider-independent: they carry router ids,
 * never SDK-specific config or credentials.
 */
export const QUEUE_NAMES = {
  transcription: 'transcription',
  ai: 'ai',
  email: 'email',
} as const;
export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

/** Known STT router ids. AssemblyAI is primary; faster-whisper is local; Deepgram optional. */
export const SttProviderId = Type.Union([
  Type.Literal('assemblyai'),
  Type.Literal('faster-whisper'),
  Type.Literal('deepgram'),
]);
export type SttProviderId = Static<typeof SttProviderId>;

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
  diarize: Type.Boolean({ default: true }),
  fallback: Type.Optional(FallbackPolicy),
}, { additionalProperties: false });
export type TranscriptionJobPayload = Static<typeof TranscriptionJobPayload>;

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

/**
 * Email jobs carry ids only: no tokens, email addresses, names or links.
 * The worker loads the recipient from the DB and builds any links (reset, invite)
 * server-side, then sends via the EmailService abstraction.
 */
export const EmailTemplateId = Type.Union([
  Type.Literal('invite'),
  Type.Literal('verify_email'),
  Type.Literal('reset_password'),
  Type.Literal('meeting_summary'),
]);
export type EmailTemplateId = Static<typeof EmailTemplateId>;

/** `invite` requires invitationId. Every other template requires userId. Discriminated on templateId. */
export const EmailJobPayload = Type.Union([
  Type.Object(
    { ...JobMeta, kind: Type.Literal('send_email'), templateId: Type.Literal('invite'), invitationId: Id },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...JobMeta,
      kind: Type.Literal('send_email'),
      templateId: Type.Union([Type.Literal('verify_email'), Type.Literal('reset_password'), Type.Literal('meeting_summary')]),
      userId: Id,
    },
    { additionalProperties: false },
  ),
]);
export type EmailJobPayload = Static<typeof EmailJobPayload>;
