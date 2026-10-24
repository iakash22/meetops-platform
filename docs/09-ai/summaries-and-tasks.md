# Summaries, decisions, action items, draft tasks

## Prompts and schemas (versioned)

- Prompt versions: `meeting-map@1` and `meeting-reduce@1` (`EXTRACTION_PROMPT_VERSION`). They are recorded as
  `promptVersion = "meeting-map@1+meeting-reduce@1"` on every result, together with `transcriptRevision`.
- All schemas are `.strict()` zod. Extra keys are rejected. A failure triggers a bounded repair (max 2), then
  `INVALID_OUTPUT`.
  - `mapOutputSchema`: `{ summary, decisions[], actionItems[] }`
  - `reduceOutputSchema`: `{ summary, keyPoints[] }`
  - `meetingExtractionSchema`: the final result, `schemaVersion: 1`
- `draftTaskSchema.status` is `z.literal('draft')`. There is no field for an assignee identity.
- `assigneeHint` and `dueHint` are **untrusted text**. They are sanitized (control characters and `<>` and backticks
  removed, max 120 chars), shown for display only, and never resolved to a user here. Backend may suggest same-org
  members, but a human must confirm.

## Untrusted transcript

Every prompt is built with `buildTranscriptPrompt()`. Transcript lines appear as `[segmentId] Speaker: text` inside
`<untrusted_transcript>`, and delimiter sequences in transcript text and the title are escaped. The system prompt marks
the block as data. In the reduce step, partial summaries are fenced the same way.

## Map-reduce for long transcripts

1. **Chunk.** `chunkSegmentsByTokens(segments, budget=6000, overlap)` estimates about 4 chars per token. Segments are
   never split.
2. **Map.** One structured call per window, at temperature 0.
3. **Reduce.**
   - Summary: an LLM call combines the partial summaries, only when there is more than one window.
   - Decisions and action items: merged **deterministically in code**, deduped by normalized text, with their evidence
     unioned.
4. **Evidence.** Segment ids are resolved to `{ segmentId, startSec, endSec }`. Unknown ids are dropped, and an item left
   with no evidence is flagged `no-evidence`.
5. **Flags.** Items whose text looks like an injection are flagged `possible-injection`.
6. **Draft tasks.** `draftTasks` holds only the unflagged items. Flagged items stay in `actionItems`, as drafts, for human
   review.

## Job entry point

`runExtractionJob(executor, AiJobPayload, { revision, segments, title })`. The idempotency key is
`<payload.idempotencyKey>:rev<revision>:<promptVersion>`, so re-running the same transcript revision costs nothing.

## Output token caps per feature and step

Every LLM provider config uses `SUMMARY_OUTPUT_LIMITS` from `bootstrap.ts`:

| Call                                                          | Cap            |
| ------------------------------------------------------------- | -------------- |
| `summary` feature (no step)                                   | 4096           |
| map-reduce **reduce** step                                    | 4096           |
| map steps and extraction features (`actions`, `deadlines`, …) | 2048 (default) |

- **Steps:** the pipeline tags each call with `step: 'map' | 'reduce'` (an `LLMGenerate*Params.step` field).
- **Precedence:** explicit `maxTokens`, then `perFeatureStep[feature][step]`, then `perStep[step]`, then
  `perFeature[feature]`, then `defaultMaxTokens`.
- **Clamping:** the result is always clamped to `maxTokens` and the 8192 hard max. The config schema rejects any
  value above 8192.
- **Eval check:** the eval mock computes the exact cap an adapter would send and simulates `MAX_TOKENS` truncation.
  On the fixtures the worst output uses 13.8% of its cap (long meeting, 565 tokens), so there's no truncation and
  extraction stays at 2048. Truncation on real models still needs a live eval.
