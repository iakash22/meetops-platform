/**
 * Thin local mirror of the job/router contracts from @meetops/contracts (PR #17, feat/core-contracts, not merged yet).
 * TODO(contracts): once PR #17 is on main, add "@meetops/contracts": "workspace:*" and replace these declarations with
 *   export type { LlmProviderId, SttProviderId, ModelRouteId, FallbackPolicy, AiJobPayload, TranscriptionJobPayload } from '@meetops/contracts';
 * The shapes below are kept identical so the swap is type-only.
 */
import type { AIFeature, RequestOverride } from './router.js';

export type LlmProviderId = 'gemini' | 'ollama' | 'openai';
export type SttProviderId = 'assemblyai' | 'faster-whisper' | 'deepgram';
/** "<provider>:<model>", e.g. "gemini:gemini-2.5-flash-lite". */
export type ModelRouteId = string;
export type FallbackPolicy = { fallbackRouteIds: string[]; allowPaidFallback: boolean };
export type AiTaskKind = 'summarize_meeting' | 'extract_tasks' | 'embed_transcript';

type JobMeta = { jobVersion: 1; organizationId: string; requestId?: string; idempotencyKey: string };
export type AiJobPayload = JobMeta & {
  kind: AiTaskKind;
  meetingId: string;
  transcriptId: string;
  modelRouteId: ModelRouteId;
  promptVersion: string;
  fallback?: FallbackPolicy;
};
export type TranscriptionJobPayload = JobMeta & {
  kind: 'transcribe_recording';
  meetingId: string;
  recordingId: string;
  fileObjectId: string;
  sttProviderId: SttProviderId;
  languageHint?: string;
  diarize: boolean;
  fallback?: FallbackPolicy;
};

const ROUTE_RE = /^(gemini|ollama|openai):([A-Za-z0-9._\-/]+)$/;

export function parseModelRouteId(id: ModelRouteId): { provider: LlmProviderId; model: string } {
  const m = ROUTE_RE.exec(id);
  if (!m?.[1] || !m[2]) throw new Error(`Invalid modelRouteId "${id}"`);
  return { provider: m[1] as LlmProviderId, model: m[2] };
}
export const formatModelRouteId = (provider: LlmProviderId, model: string): ModelRouteId => `${provider}:${model}`;

const KIND_FEATURE: Record<AiTaskKind, AIFeature> = { summarize_meeting: 'summary', extract_tasks: 'actions', embed_transcript: 'summary' };

/**
 * Map a queue payload to executor inputs. The payload's route is treated as an AUTHORIZED request override only because
 * job payloads are produced server-side; fallbacks are only those listed explicitly (no automatic paid fallback).
 */
export function aiJobToRequest(p: AiJobPayload): { tenantId: string; feature: AIFeature; promptVersion: string; idempotencyKey: string; override: RequestOverride } {
  const { provider, model } = parseModelRouteId(p.modelRouteId);
  return {
    tenantId: p.organizationId,
    feature: KIND_FEATURE[p.kind],
    promptVersion: p.promptVersion,
    idempotencyKey: p.idempotencyKey,
    override: { provider, model, fallbacks: (p.fallback?.fallbackRouteIds ?? []).map((r) => parseModelRouteId(r).provider), authorized: true },
  };
}

export function transcriptionJobToRequest(p: TranscriptionJobPayload): { tenantId: string; feature: AIFeature; idempotencyKey: string; override: RequestOverride } {
  return {
    tenantId: p.organizationId,
    feature: 'transcription',
    idempotencyKey: p.idempotencyKey,
    override: { provider: p.sttProviderId, fallbacks: (p.fallback?.fallbackRouteIds ?? []).map((r) => r.split(':')[0] ?? r), authorized: true },
  };
}
