# Phase 3 AI pipeline: notes and parked decisions

Worker-side AI pipeline in `apps/worker/src/ai`, behind provider interfaces, plain `fetch` only (no SDKs, no new
dependencies, no lockfile change). Every test uses mocked fetch or fake providers; no test makes a network call.

## PR 1: feat/worker-transcription-provider

- `providers/transcription-provider.ts`: `TranscriptionProvider` port (`transcribe`, `fetchResult`).
- `providers/assemblyai.ts`: AssemblyAI adapter. Upload (bytes) or URL submit, polling or webhook mode
  (`ASSEMBLYAI_WEBHOOK_URL` + shared-header secret, verified with `timingSafeEqual`), speaker labels mapped from
  utterances, per-request and overall timeouts, error mapping to `ProviderError` codes
  (`auth`, `rate_limited`, `unavailable`, `invalid_request`, `timeout`, `provider_failed`, `bad_response`).
  Error messages carry no key, no URL and no response body.
- `recording-transcription.ts`: whole-recording job, stored through the #212 `TranscriptRepository` as chunk 0
  of a one-chunk recording, so it shares merge and storage with the chunk pipeline.
  - Idempotent: the raw provider result is stored first (first write wins), so retries never call the provider again
    once it has answered; a revision is written by compare-and-set only when content changes.
  - Failed status: on a permanent error, or the final BullMQ attempt, the revision-0 anchor gets `status = failed`
    (`markTranscriptFailed`, new on the Prisma repository).
  - Logs carry ids and error codes only, never the audio URL or transcript text.
- Not registered on a queue yet: there is no contracts job payload for whole-recording transcription. The existing
  chunk consumer (`QUEUE_NAMES.transcription`) is unchanged.

## Parked decisions (need Shubham). Defaults in brackets are what the code does today.

1. STT model: [`universal` via `ASSEMBLYAI_SPEECH_MODEL`, language auto-detect unless the job passes one].
2. Polling vs webhook: [polling, 5 s interval, 30 min overall budget]. Webhook mode needs a public API route
   (`verifyAssemblyAiWebhook` and `parseAssemblyAiWebhook` are ready) and a webhook secret.
3. Audio delivery: [short-lived presigned https URL from storage]; byte upload is supported as a fallback.
4. Data retention at the provider: [not requested]. AssemblyAI keeps uploads and transcripts until deleted; decide
   whether to call `DELETE /v2/transcript/:id` after storing.
5. Re-submission cost: a crash between the provider answer and the DB write re-submits the audio (no provider
   idempotency key). [Accepted]; storing `providerJobId` before polling would close it.
6. A later success after `failed` leaves the anchor at `failed`, while revision >= 1 is `ready`. Readers should use the
   latest revision >= 1. [Accepted.]
7. PII redaction (AssemblyAI `redact_pii`): [off]. Turning it on changes transcript text for every downstream step.

## PR 2: feat/worker-ai-summary-provider

- `LlmProvider` interface (`providers/llm-provider.ts`) + `GeminiLlmProvider` fetch adapter (`generateContent`, JSON mime type, key in `x-goog-api-key` header, never in URL or logs). Safety block → `provider_failed`; `MAX_TOKENS` → `bad_response`.
- `processMeetingSummary` / `createMeetingSummaryProcessor` (`ai/meeting-summary.ts`): loads the latest `ready` merged transcript, prompts the model, validates strict JSON (TypeBox, built from contracts `ReportContent`, `ReportActionItem`, `TaskPriority`, `additionalProperties: false`), stores via `SummaryRepository`.
- Prompt-injection posture: transcript is untrusted data inside a random per-call nonce fence; fence-like tags, control and bidi chars are stripped; the model is told never to follow transcript instructions; output is only parsed as data — no tools, no execution, extra keys (e.g. `status: "approved"`) reject the whole output. Assignee/due values stay _hints_ and are never resolved to users.
- Extracted tasks are always inserted as `pending_review` by the repository; the model cannot set status.
- Idempotent per (transcript, revision, `SUMMARY_PROMPT_VERSION`): an existing succeeded `summary` AiRun with a report short-circuits. Failures write a `failed` AiRun (non-retryable immediately, retryable on the final attempt).

### Parked decisions (PR 2) — defaults in place, need Shubham

8. **LLM model**: default `gemini-2.5-flash-lite` (override `GEMINI_MODEL`). Alternative: `gemini-2.5-flash` for quality.
9. **Data retention at Google**: paid Gemini API tier assumed (no training on data; abuse-monitoring retention per Google terms). Free tier must NOT be used with customer data.
10. **PII redaction before LLM**: off; transcript sent as-is. Option: redact emails/phones before prompting.
11. **Cost cap**: refuse (not truncate) transcripts over `AI_SUMMARY_MAX_TRANSCRIPT_CHARS` = 200 000 chars (~50k tokens); output capped at `AI_SUMMARY_MAX_OUTPUT_TOKENS` = 8192. No per-org monthly budget yet.
12. **Long-meeting policy**: refuse with `transcript_too_large`; alternative is map-reduce chunked summarization (later PR).
13. **Prompt versioning**: `meeting-summary@1`; bumping it allows a new report version for the same transcript.
14. **Concurrent duplicates**: idempotency is check-then-insert inside one org transaction, no DB unique key on AiRun; relies on one queue job id per meeting+revision. Option: add a partial unique index (migration) later.
15. **Enqueue trigger**: not wired yet — who enqueues summary after transcript `ready` (worker chain vs API) is undecided.

## Report summary dedupe (defaults)

- Migration `20261027120000_report_summary_dedupe` (additive): nullable `reports.transcript_revision` (CHECK NULL or >= 1), nullable `reports.prompt_version`, and unique index `reports_summary_dedupe_key` on `(meeting_id, transcript_id, transcript_revision, prompt_version)`.
- Postgres treats NULLs as distinct, so legacy/manual reports (NULL revision/prompt) are unaffected.
- The summary repository looks up the existing report by the key (soft-deleted rows included) before calling the LLM and before inserting.
- A concurrent insert of the same key (Prisma `P2002` / SQLSTATE `23505`) aborts that transaction (AiRun rolled back too); the repository re-reads in a fresh transaction and returns the winner as `created=false` (job result `duplicate: true`). Any other unique conflict (e.g. the `(meeting_id, version)` race) is rethrown and the job retries.
- A soft-deleted report still holds its key: regenerating a summary for the same transcript revision requires bumping `SUMMARY_PROMPT_VERSION`.
