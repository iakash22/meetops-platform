# DevOps Agent handover (2026-10-24)

## Current work

- Scope: containers and compose, CI/CD, environment config, monitoring, backups and runbooks.
- Paused by the owner. The only exception is this handover.

## Open PRs (base integration/phase-1 unless noted)

| PR                                              | Head                      | Status / blocker                                                                            |
| ----------------------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------- |
| #101 deps                                       | 2d14358                   | CI passed. Audit 0/15/28/3. Queued for review first.                                        |
| #102 deps (engines >=20.19 <23)                 | 636d33e                   | Audit 0/17/27/5. Merges after #101, with the lockfile regenerated.                          |
| #99 deps                                        | 8ee3d2e                   | Audit 0/14/23/5. Merges after #102, with the lockfile regenerated.                          |
| #7 Docker/compose/infra + socket.io-adapter fix | e7e5cfa                   | STT host port is 8001. Its audit gate stays red until the dependency PRs land.              |
| #80 zod4 plan                                   | 8212031                   | Awaiting review.                                                                            |
| #95 compose MinIO                               | 23be850                   | Awaiting review.                                                                            |
| #96 storage-key runbooks                        | 33abe7e                   | Awaiting review.                                                                            |
| #106 lint-staged fix                            | db03c08                   | Adds test/tsconfig.json per package and `projectService: true`. Expect a conflict with #40. |
| #26                                             | 8629f10                   | CI green.                                                                                   |
| #34, #32, #40                                   | 9ab3b00, 6f59edc, 96092ca | Awaiting review.                                                                            |
| #108 RLS follow-up                              | a13c2fc                   | Being merged by the coordinator.                                                            |

Merged: #73 (vitest 3.2.7) and #79 (CI services, 8eabf48). Closed: #33, superseded.

## Actions minutes situation

The repo is out of free GitHub Actions minutes. CI jobs fail in about 2 seconds with 0 steps. Akash chose local gates in place of CI: build, lint, typecheck, tests, gitleaks and `pnpm audit`, all run locally. No re-runs are needed.

## Hook fix

Some earlier commits (including the #106 commit and six before it) were made with hooks skipped. This was disclosed. Since then:

- `core.hooksPath` must be `.husky/_`. Verify it before every commit.
- Never use `--no-verify`.

## Next queued tasks (after the pause lifts and the PRs clear)

1. Regenerate lockfiles in this order: #102 after #101 merges, then #99, then #7. Procedure: take the base `pnpm-lock.yaml`, run `pnpm install`, then confirm `pnpm install --frozen-lockfile`. A text merge of the lockfile can break silently (for example a duplicate undici key).
2. Align STT on port 8001 in .env.example, the compose files and docs/09-ai/provider-abstraction.md.
3. Write the queue pause/resume script. MAINTENANCE_MODE belongs to Backend.
4. Add extension tooling overrides for adm-zip, tmp and uuid.
5. Review the Database Agent's backfill PR (packages/database/scripts/storage-key-backfill.ts).
6. Storage-key dev wipe (after #82 merges) and staging copy. Each run needs Akash's own go-ahead.

## Decisions and gotchas

- Pin CI actions by SHA and images by digest.
- No force-push and no rebase; merge instead.
- Only the coordinator merges into integration, under the gates. Only Akash merges main.
- Use pnpm 9.12.3 via corepack. Run turbo with `--concurrency=2` because the box is under heavy load.
- The token gets a 403 on `gh pr checks`. Use `gh run list/view` instead.
- Remotes use the plain https URL, with auth through `gh auth setup-git`. Never embed a token.
- Changes to the box system or firewall need Akash's own approval.
- inotify: the max_user_watches limit was raised to 524288 because of ENOSPC errors.
- Don't install Docker without asking.

## How to resume

1. Work in /workspace/agents/devops/{repo, vitest, ci-services, storage-keys, lintstaged}. Run `git fetch` first.
2. Check `git config core.hooksPath` (it must be `.husky/_`).
3. Check the merge state of #101, #102 and #99, then continue the lockfile sequence.
4. Run the local gates and report heads, gate results and audit counts to the coordinator.
