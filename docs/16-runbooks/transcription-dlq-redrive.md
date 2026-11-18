# Re-drive dead-lettered transcription jobs

Transcription jobs that use up their retries (provider outage) land in the `transcription-dlq` queue and the meeting
shows **Transcription delayed** (PR #414). Once the provider is healthy again, re-drive them by hand.

```bash
# 1. Always start with a dry run. Prints ids and error codes only.
pnpm --filter @meetops/worker dlq:redrive -- --all --dry-run
# 2. Re-drive one job, one organization, or everything. Asks for "yes" before changing anything.
pnpm --filter @meetops/worker dlq:redrive -- --job <jobId>   # original job id or the DLQ id (dlq_…)
pnpm --filter @meetops/worker dlq:redrive -- --org <organizationId>
pnpm --filter @meetops/worker dlq:redrive -- --all
```

Needs `REDIS_URL` and `DATABASE_URL` (app role) for the environment; nothing else.

What it does per matching DLQ entry:

| Original job state                            | Action                                                                                                       | DLQ entry |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | --------- |
| `failed`                                      | `requeued`: retried with fresh attempts and the same backoff; meeting reset (see below)                    | removed   |
| waiting / active / completed                  | `already_requeued` (an earlier run handled it); meeting status is not touched                               | removed   |
| missing (`removeOnFail` expired after 7 days) | `missing_original`: re-upload or re-run media processing for the recording                                   | kept      |

It is safe to run twice: an original that is not `failed` is never retried again, and the DLQ entry is removed only
after the retry. `--yes` skips the prompt (for scripted use only, after a dry run). Abort with anything but `yes`.

Meeting status: a meeting goes from `transcription_delayed` back to `processing` only when this run re-queued one of
its jobs (not `already_requeued`) **and** no other chunk of that meeting is still in the DLQ afterwards (including
`missing_original` entries and entries outside the filter). Otherwise it stays `transcription_delayed`; the worker
also moves it out when a later attempt succeeds (`processing`) or fails permanently (`failed`).

DLQ job ids use the `dlq_` prefix with no `:` (BullMQ 5.81 rejects `:` in custom ids).
