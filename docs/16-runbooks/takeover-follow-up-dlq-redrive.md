# Re-drive dead-lettered account-takeover follow-ups

After a mailbox owner takes an account over, revocations that still fail in-request run as durable BullMQ jobs on
`auth-takeover-follow-up` (realtime kick, extension/desktop token families, push devices; see
`docs/04-api/auth-and-orgs.md`). A job that uses up its 6 attempts is copied to `auth-takeover-follow-up-dlq` as
`dlq_<jobId>` and the API logs `auth.takeover.follow_up_abandoned`. The alert is
`MeetOpsTakeoverFollowUpDlqNotEmpty` (`docs/14-observability/alerts.md`).

Treat a non-empty DLQ as security-relevant: the takeover committed, but a revocation may still be outstanding. Fix the
failing dependency first (Redis for realtime, Postgres for token families or push devices), then re-drive.

```bash
# 1. Dry run (the default). Prints ids, the follow-up kind and an error class only.
pnpm --filter @meetops/api takeover:redrive -- --all
# 2. Re-drive one entry, one user, one kind, or everything. Asks for "yes" before changing anything.
pnpm --filter @meetops/api takeover:redrive -- --job <id> --apply   # takeover_<kind>_<hash> or dlq_takeover_…
pnpm --filter @meetops/api takeover:redrive -- --user <userId> --apply
pnpm --filter @meetops/api takeover:redrive -- --kind extension_tokens --apply
pnpm --filter @meetops/api takeover:redrive -- --all --apply
```

`takeover:redrive` runs the built script (`node dist/scripts/takeover-dlq-redrive.js`, after
`pnpm --filter @meetops/api build`); `takeover:redrive:dev` runs the TypeScript source with tsx. Both need `REDIS_URL`
and, if the API sets one, the same `AUTH_MAIL_QUEUE_PREFIX` (otherwise the script reads an empty DLQ under `bull`).
Nothing else is read; no database access is needed. The Redis URL is never printed and credentials in error messages
are masked.

What it does per matching DLQ entry:

| Original job state                          | Action                                                                        | DLQ entry |
| ------------------------------------------- | ----------------------------------------------------------------------------- | --------- |
| `failed` (kept 7 days)                      | `requeued`: retried with fresh attempts and the same backoff                  | removed   |
| missing (completed, or `removeOnFail` aged) | `enqueued`: a fresh job under the same deterministic id, runs now, 6 attempts | removed   |
| waiting / delayed / active                  | `already_requeued` (an earlier run or a new takeover already queued it)       | removed   |
| payload or ids do not validate              | `invalid_payload`: nothing enqueued; inspect and delete the entry by hand     | kept      |

A dry run reports `would_requeue`, `would_enqueue` or `would_drop_duplicate` instead and changes nothing.

Safety:

- Idempotent. Every follow-up kind is idempotent, the DLQ entry is removed only after the retry or enqueue, the state is
  re-read just before acting, a pending original is never retried again, and enqueues reuse the deterministic job id
  (`takeover_<kind>_<sha256>`), so BullMQ dedupes a concurrent second run.
- Payload validation. An entry is acted on only when its payload is `{ userId, kind }` with a valid user id and kind,
  and both its job id and its `dlq_` id are the deterministic ones for that payload. Anything else is
  `invalid_payload`, so a tampered entry cannot retry or enqueue an arbitrary job.
- `--yes` skips the prompt (for scripted use only, after a dry run). `--dry-run` always wins over `--apply`.

DLQ job ids use the `dlq_` prefix with no `:` (BullMQ 5.81 rejects `:` in custom ids).
