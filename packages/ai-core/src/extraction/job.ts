import type { AIExecutor, JobOutcome } from '../executor.js';
import type { LLMProvider } from '../types.js';
import type { TenantContext } from '../auth.js';
import { aiJobToRequest, type AiJobPayload } from '../contracts.js';
import { extractMeeting, type ExtractionSegment } from './pipeline.js';
import { EXTRACTION_PROMPT_VERSION, type MeetingExtraction } from './schemas.js';

/** Run summary/task extraction for an AiJobPayload (kind summarize_meeting | extract_tasks) through the executor. */
export async function runExtractionJob(
  executor: AIExecutor,
  payload: AiJobPayload,
  transcript: { revision: number; segments: ExtractionSegment[]; title?: string | undefined },
  /** actor: server-derived context (never from payload); required for the payload route to act as an override. */
  opts: { windowTokenBudget?: number | undefined; actor?: TenantContext | undefined } = {},
): Promise<JobOutcome<MeetingExtraction>> {
  const base = aiJobToRequest(payload);
  return executor.run(
    {
      ...base,
      override: opts.actor ? base.override : undefined,
      actor: opts.actor,
      requestId: payload.requestId,
      // Idempotent per tenant + meeting + transcript revision + prompt version.
      idempotencyKey: `${payload.idempotencyKey}:rev${transcript.revision}:${EXTRACTION_PROMPT_VERSION.map}`,
      promptVersion: `${EXTRACTION_PROMPT_VERSION.map}+${EXTRACTION_PROMPT_VERSION.reduce}`,
      transcriptRevision: transcript.revision,
      jobId: payload.requestId,
    },
    async (provider, ctx) => {
      const r = await extractMeeting(provider as LLMProvider, transcript.segments, {
        model: ctx.model,
        transcriptRevision: transcript.revision,
        title: transcript.title,
        signal: ctx.signal,
        windowTokenBudget: opts.windowTokenBudget,
      });
      return { value: r.value, usage: { inputTokens: r.usage.inputTokens, outputTokens: r.usage.outputTokens, totalTokens: r.usage.totalTokens } };
    },
  );
}
