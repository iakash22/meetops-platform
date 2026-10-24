# Runbook: staging copy `org/` → `organizations/{organizationId}/`

**Scope:** staging only. Uses the Database Agent's backfill script (branch `feat/db-storage-key-backfill`).
**Status:** the branch did not exist when this runbook was written; flags below are the **required
contract** for that script (see "Script contract"). Update this doc once it lands.
**Order (decided):** deploy #82 to staging **first**, then run the backfill. #82 reads both `org/` and
`organizations/` keys, so rows on either prefix resolve during and after the backfill and the order carries no risk.
New writes after the #82 deploy already use `organizations/`.

**Schema comment:** the `FileObject.key` comment ("Always prefixed org/") is being fixed by Media in #82.

## Approvals

| Step                                               | Approver                                               |
| -------------------------------------------------- | ------------------------------------------------------ |
| Snapshot + versioning check                        | DevOps operator (record evidence in the change ticket) |
| Review dry-run output                              | DevOps + Database Agent owner                          |
| **`--apply` on staging**                           | **Akash, directly, immediately before running**        |
| Old `org/` object cleanup (later, separate change) | Akash, separate approval                               |

## Prerequisites and backups

1. Env from the secret store, names only: `DATABASE_URL`, `STORAGE_PROVIDER`, `STORAGE_ENDPOINT`,
   `STORAGE_REGION`, `STORAGE_BUCKET`, `STORAGE_ACCESS_KEY_ID`, `STORAGE_SECRET_ACCESS_KEY`,
   `STORAGE_FORCE_PATH_STYLE`. Never paste values into tickets, chat, or logs; no `set -x`.
2. **DB snapshot** of the staging database; record the snapshot id. Do not proceed without it.
3. **Bucket versioning check (required precondition, result recorded)**. Run it and record the output in the change record. Versioning should be: `aws s3api get-bucket-versioning --bucket "$STORAGE_BUCKET"`
   (or `mc version info`) → `Enabled`. If it is `Suspended` or unset, record that and tell Akash before the apply. The process is safe either way:
   it only copies and never deletes or overwrites `org/` objects. Versioning is extra protection, not a dependency.
4. Pause writers (see "Pause and resume writers"), so no new `org/` rows appear mid-run.
5. Capture baseline: `select org_id, count(*) from file_objects where storage_key like 'org/%' group by 1;`

## Pause and resume writers

**What's missing:** the repo has no existing queue-pause command or maintenance/upload-disable flag (searched
`apps/`, `packages/`, `.env.example`). The worker uses BullMQ (`apps/worker/src/media/worker.ts`). Until a
sanctioned mechanism exists, use the steps below. A follow-up should add a `MAINTENANCE_MODE`/uploads-disabled flag and a
queue pause/resume script.

Before the apply (after the dry-run is reviewed):

1. Uploads: scale the staging web/API upload path to read-only, or announce a staging freeze. With no flag, the safe
   option is to tell staging users and stop the extension/web upload traffic for the window.
2. Worker: pause the BullMQ media queue (`Queue.pause()` on the media queue), or scale staging worker replicas to 0.
   Wait for active jobs to finish.
3. Record pause time and in-flight job count in the change record.

After verification passes:

1. Resume the media queue (`Queue.resume()`) or scale the workers back up. Re-enable uploads.
2. Smoke-test one upload. Its key must start with `organizations/{organizationId}/`.
3. Record resume time.

## 1. Dry-run (default) and review

```sh
pnpm --filter @meetops/database exec tsx scripts/storage-key-backfill.ts --dry-run --report=dryrun.jsonl
```

Review: per-org planned copies match the baseline; no `error` lines; no rows whose source object is missing;
no unexpected destination conflicts. Share the summary (not env) with the approvers.

## 2. Apply (after Akash approves)

```sh
pnpm --filter @meetops/database exec tsx scripts/storage-key-backfill.ts --apply --report=apply.jsonl
```

Script copies only (never moves/deletes), verifies size + checksum, then updates `file_objects.storage_key`
in one transaction per org.

## 3. Verify

- `select count(*) from file_objects where storage_key like 'org/%';` → `0`
- `select count(*) from file_objects where storage_key not like 'organizations/' || org_id || '/%';` → `0`
- Per org: object count under `organizations/{orgId}/` ≥ baseline `org/{orgId}/` count, and the report's
  `verified` count equals planned.
- Checksums: report shows `size_match=true` and `checksum_match=true` for every object; spot-check a few with
  `head-object` on source vs destination.
- Smoke test: download an existing recording and upload a new one in staging (after #82 deploy).

## Re-run safety

The script is idempotent: re-running skips rows already on `organizations/` and destinations already verified.
A second `--dry-run` after apply must report **0 planned changes**. Safe to re-run after a partial failure.

## Old objects

`org/` objects are kept. Deleting them is a **separate, later change** with its own approval from Akash,
after at least one release cycle and with versioning still enabled.

## Monitoring and abort criteria

Watch: script report error count, DB locks/long transactions, S3 4xx/5xx rates, app error rate on media download.
**Abort** (Ctrl-C between orgs; transactions are per org) if any of:

- any checksum or size mismatch;
- any S3 5xx/throttling persisting > 1 min, or any AccessDenied;
- DB transaction > 60 s or lock waits affecting the app;
- staging media download errors rise.

## Rollback

- DB: keys only changed per committed org; restore by reverting keys (`organizations/{id}/` → `org/{id}/`) via
  the script's rollback mode if provided, or restore the snapshot.
- Storage: nothing deleted, so old keys still resolve; new copies can be left in place.

## Evidence checklist (owner: DevOps)

DevOps owns the DB snapshot and the change evidence. Attach everything to the change record with secrets redacted
(no env values, connection strings, access keys, or presigned URLs):

- [ ] Staging DB snapshot id and timestamp, taken before the apply
- [ ] Bucket versioning check output (Enabled/Suspended/unset)
- [ ] Baseline per-org `org/` counts (SQL output)
- [ ] Dry-run report (`dryrun.jsonl`) and summary, with reviewer sign-off
- [ ] Akash's go-ahead for this specific apply run (link/quote, with time)
- [ ] Writer pause time and in-flight jobs
- [ ] Apply report (`apply.jsonl`) and exit code
- [ ] Verification SQL output (0 `org/` keys, 0 mismatched prefixes), per-org counts, checksum results
- [ ] Post-apply dry-run showing 0 planned changes
- [ ] Resume time and smoke-test result

## Script contract (required from the Database Agent's script)

- Location/entry: `packages/database/scripts/storage-key-backfill.ts` (or document the actual path).
- Flags: `--dry-run` (default), `--apply`, `--org=<uuid>` (repeatable, for canary), `--report=<path>`,
  `--batch-size=<n>`, optional `--rollback`.
- Reads only `DATABASE_URL` and `STORAGE_*`; refuses if `STORAGE_BUCKET` / host looks like prod; never logs secrets or presigned URLs.
- Output: JSON lines, one per object: `{org_id, file_object_id, src_key, dst_key, action: copy|skip|error, size_match, checksum_match}`,
  then one summary line per org: `{org_id, planned, copied, skipped, verified, errors, committed}` and a final total.
- Exit codes: `0` ok, non-zero on any error or mismatch (org transaction not committed).
- Checksum source: `checksum_sha256` column when present, otherwise computed on read; ETag alone is not enough for multipart.
