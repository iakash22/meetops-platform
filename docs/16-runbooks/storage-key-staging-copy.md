# Runbook: staging copy `org/` → `organizations/{organizationId}/`

**Scope:** staging only. Uses the Database Agent's backfill script (branch `feat/db-storage-key-backfill`).
**Status:** the branch did not exist when this runbook was written; flags below are the **required
contract** for that script (see "Script contract"). Update this doc once it lands.
**Order:** PR #82 merged → this backfill applied → deploy #82 code to staging (or deploy with a read fallback; see open questions).

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
3. **Bucket versioning** must be enabled: `aws s3api get-bucket-versioning --bucket "$STORAGE_BUCKET"`
   (or `mc version info`) → `Enabled`. If not, stop and ask Akash.
4. Pause/quiesce writers (worker queue, uploads) or schedule a low-traffic window, so no new `org/` rows appear mid-run.
5. Capture baseline: `select org_id, count(*) from file_objects where storage_key like 'org/%' group by 1;`

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

## Script contract (required from the Database Agent's script)

- Location/entry: `packages/database/scripts/storage-key-backfill.ts` (or document the actual path).
- Flags: `--dry-run` (default), `--apply`, `--org=<uuid>` (repeatable, for canary), `--report=<path>`,
  `--batch-size=<n>`, optional `--rollback`.
- Reads only `DATABASE_URL` and `STORAGE_*`; refuses if `STORAGE_BUCKET` / host looks like prod; never logs secrets or presigned URLs.
- Output: JSON lines, one per object: `{org_id, file_object_id, src_key, dst_key, action: copy|skip|error, size_match, checksum_match}`,
  then one summary line per org: `{org_id, planned, copied, skipped, verified, errors, committed}` and a final total.
- Exit codes: `0` ok, non-zero on any error or mismatch (org transaction not committed).
- Checksum source: `checksum_sha256` column when present, otherwise computed on read; ETag alone is not enough for multipart.
