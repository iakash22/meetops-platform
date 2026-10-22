# Agent workflow

Rules for every agent working on this repo. See also [`CONTRIBUTING.md`](../../CONTRIBUTING.md) and [execution rules](../17-agents/execution-rules.md) (no Cursor).

## 1. One clone per agent

Each agent works in its own clone under an area-named folder, `/workspace/agents/<area>`. Existing folders: `ai`, `architecture`, `backend` and `database`; new areas follow the same pattern. Never work in, reset or delete another agent's clone. The box is shared, and a shared checkout gets clobbered.

```bash
git clone https://github.com/iakash22/meetops-platform.git /workspace/agents/<area>
cd /workspace/agents/<area>
git config user.name "<area>"   # local to the clone
```

## 2. Pin pnpm with Corepack

`package.json` pins `"packageManager": "pnpm@9.12.3"`.

```bash
corepack enable
corepack prepare pnpm@9.12.3 --activate
pnpm --version                  # must print 9.12.3
pnpm install --frozen-lockfile
```

Using the pinned version keeps lockfile diffs minimal.

- Don't regenerate, re-resolve or reformat `pnpm-lock.yaml`. Only change it by adding or removing a dependency, and say so in the PR.
- If `--frozen-lockfile` fails, stop and report it; don't delete the lockfile.

## 3. Git rules

- Never use `--no-verify`. Fix whatever the pre-commit hook (`pnpm lint-staged`) reports.
- Never force-push a branch that has been pushed. Update it by merging:

  ```bash
  git fetch origin
  git merge origin/main          # or the base branch of a stacked PR
  git push
  ```

- Conventional Commits, small and scoped (`docs(agents): ...`). No commitlint config exists yet; DevOps is adding one, and it will enforce this.
- Never commit secrets or `.env`.

## 4. Pre-PR checks

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm build
```

All four exist as root scripts. There's no `format:check` script; for Markdown run `npx prettier --check <files>`. E2E tests are separate (see [testing](testing.md)). Report the actual results in the PR; never claim a check passed if you didn't run it.

## 5. Phase 1 integration branch

Phase 1 work merges through **`integration/phase-1`** (it exists on `origin`), not directly into `main`:

1. Agent PRs target `integration/phase-1`: `gh pr create --base integration/phase-1 ...`.
2. A PR merges into `integration/phase-1` only after **CI passes** and **Architecture and Security review** approve it. Use merge commits, not squash.
3. **Akash merges the single integration PR** (`integration/phase-1` → `main`, currently #30 "Phase 1 integration") into `main`. Agents never merge into `main`.
4. To catch up, merge `origin/integration/phase-1` into your branch, not `origin/main` (no rebase, no force-push).

## 6. Stacked PRs

When a task builds on an unmerged PR, branch from that PR's branch and open the PR against it:

```bash
git fetch origin
git checkout -b docs/next origin/docs/lower
# ...commit...
git push -u origin docs/next
gh pr create --base docs/lower --head docs/next --title "..." --body "Stacked on #<lower>."
```

After the lower PR merges, **retarget the upper PR to `integration/phase-1`** (not `main`), then merge it in:

```bash
gh pr edit <upper> --base integration/phase-1
git fetch origin && git merge origin/integration/phase-1 && git push
```

Retarget **before** the lower branch is deleted; GitHub closes PRs whose base branch disappears. The bottom PR of every stack targets `integration/phase-1` directly.

## 7. Merge order

As of 2026-10-22 12:50 IST, from `gh pr list --state all`.

### Already merged into `integration/phase-1`

- 2026-10-21 23:00–23:02 IST: #3, #8, #12, #14, #18, #23 (the docs stack), #4 (SEC), #22 (ADR-004), #17 (contracts v0.1)
- 23:30 IST: #24 (lint)
- 23:42 IST: #13 (web shell)
- 23:55 IST: #38 (contracts v0.2.0)
- 2026-10-22 00:07 IST: #27 (API auth)
- 00:27 IST: #52 (extension)

Closed without merging: #5, #15 and #37 (superseded by #52), and #46 (replaced by #51).

### Open

| PR      | Owner               | Branch                            | Base                              | Dependency                              |
| ------- | ------------------- | --------------------------------- | --------------------------------- | --------------------------------------- |
| #6      | DB                  | `feat/database-core-schema`       | `integration/phase-1`             | None                                    |
| #7      | OPS                 | `chore/devops-containers-ci`      | `integration/phase-1`             | Conflicts with #32 on `.env.example`    |
| #9      | QA                  | `test/qa-harness`                 | `integration/phase-1`             | None                                    |
| #10     | MEDIA               | `feat/storage-and-media-core`     | `integration/phase-1`             | None                                    |
| #11     | INT                 | `feat/notifications-email`        | `integration/phase-1`             | None                                    |
| #16     | MEDIA               | `feat/realtime-scaffold`          | `integration/phase-1`             | None                                    |
| #19     | INT                 | `feat/integrations-webhooks-jira` | `integration/phase-1`             | None                                    |
| #21     | AI                  | `feat/ai-provider-registry`       | `integration/phase-1`             | None                                    |
| #25     | DB                  | `feat/database-tenancy-rls`       | `feat/database-core-schema`       | Stacked on #6                           |
| #26     | OPS                 | `chore/commitlint`                | `integration/phase-1`             | None                                    |
| #28     | DOC                 | `docs/windows-local-setup`        | `integration/phase-1`             | None                                    |
| #29     | QA                  | `test/db-and-security-suites`     | `test/qa-harness`                 | Stacked on #9                           |
| #31     | DOC                 | `docs/refresh-heads`              | `docs/windows-local-setup`        | Stacked on #28                          |
| #32     | OPS                 | `chore/windows-node24-setup`      | `integration/phase-1`             | Conflicts with #7 on `.env.example`     |
| #33     | OPS                 | `chore/audit-cleanup`             | `integration/phase-1`             | None                                    |
| #34     | QA/OPS              | `ci/qa-jobs`                      | `integration/phase-1`             | None                                    |
| #35     | DB                  | `feat/database-live-verification` | `integration/phase-1`             | None                                    |
| #36     | INT                 | `feat/integrations-resilience`    | `feat/integrations-webhooks-jira` | Stacked on #19                          |
| #39     | MEDIA               | `feat/media-pipeline-worker`      | `integration/phase-1`             | None                                    |
| #40     | OPS                 | `chore/fast-pre-commit`           | `integration/phase-1`             | None                                    |
| #47     | AI                  | `feat/ai-transcription-summaries` | `feat/ai-provider-registry`       | Stacked on #21                          |
| #48     | FE                  | `feat/web-auth-meetings`          | `integration/phase-1`             | None                                    |
| #49     | OPS                 | `chore/compose-hardening`         | `chore/devops-containers-ci`      | Stacked on #7                           |
| #50     | ARCH                | `feat/contracts-v0.3`             | `integration/phase-1`             | Contracts v0.3.0, on top of merged v0.2 |
| #51     | QA                  | `test/xt-au-suites-v2`            | `test/db-and-security-suites`     | Stacked on #29                          |
| #53     | BE                  | `feat/api-persistence`            | `integration/phase-1`             | None                                    |
| this PR | DOC                 | `docs/merged-phase1`              | `docs/refresh-heads`              | Stacked on #31                          |
| #30     | Akash (integration) | `integration/phase-1`             | `main`                            | Merge last, after all Phase 1 PRs       |

Merge stacked PRs bottom-up. "Dependency" lists only stacked bases or explicit references in the PR; logical dependencies are in the [dependency graph](../17-agents/dependency-graph.md). Many PRs touch `pnpm-lock.yaml`; resolve conflicts with the pinned pnpm, without reformatting (CI fails on lockfile drift once #7 lands).
