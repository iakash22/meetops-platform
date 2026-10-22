/**
 * Job/router contracts come from @meetops/contracts (v0.2). Type-only imports: ai-core keeps no runtime dependency
 * on the TypeBox schemas; validation happens at the queue boundary (apps/worker).
 */
import type { AiJobPayload, AiTaskKind, LlmProviderId, ModelRouteId, TranscriptionJobPayload } from '@meetops/contracts';
import type { AIFeature, RequestOverride } from './router.js';

export type {
  AiJobPayload,
  AiTaskKind,
  FallbackPolicy,
  LlmProviderId,
  MediaJobPayload,
  ModelRouteId,
  SttProviderId,
  TranscriptionJobPayload,
} from '@meetops/contracts';

const ROUTE_RE = /^(gemini|ollama|openai):([A-Za-z0-9._\-/]+)$/;

export function parseModelRouteId(id: ModelRouteId): { provider: LlmProviderId; model: string } {
  const m = ROUTE_RE.exec(id);
  if (!m?.[1] || !m[2]) throw new Error(`Invalid modelRouteId "${id}"`);
  return { provider: m[1] as LlmProviderId, model: m[2] };
}
export const formatModelRouteId = (provider: LlmProviderId, model: string): ModelRouteId => `${provider}:${model}`;

const KIND_FEATURE: Record<AiTaskKind, AIFeature> = { summarize_meeting: 'summary', extract_tasks: 'actions', embed_transcript: 'summary' };

/**
 * Map a queue payload to executor inputs. The route becomes a request override that is NOT authorized by the payload:
 * the worker must pass a server-derived `actor` (TenantContext) to AIExecutor.run, whose ability decides.
 */
export function aiJobToRequest(p: AiJobPayload): { organizationId: string; feature: AIFeature; promptVersion: string; idempotencyKey: string; override: RequestOverride } {
  const { provider, model } = parseModelRouteId(p.modelRouteId);
  return {
    organizationId: p.organizationId,
    feature: KIND_FEATURE[p.kind],
    promptVersion: p.promptVersion,
    idempotencyKey: p.idempotencyKey,
    override: { provider, model, fallbacks: (p.fallback?.fallbackRouteIds ?? []).map((r) => parseModelRouteId(r).provider) },
  };
}

export function transcriptionJobToRequest(p: TranscriptionJobPayload): { organizationId: string; feature: AIFeature; idempotencyKey: string; override: RequestOverride } {
  return {
    organizationId: p.organizationId,
    feature: 'transcription',
    idempotencyKey: p.idempotencyKey,
    override: { provider: p.sttProviderId, fallbacks: (p.fallback?.fallbackRouteIds ?? []).map((r) => r.split(':')[0] ?? r) },
  };
}
