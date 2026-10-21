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

## 5. Stacked PRs

When a task builds on an unmerged PR, branch from that PR's branch and open the PR against it:

```bash
git fetch origin
git checkout -b docs/next origin/docs/lower
# ...commit...
git push -u origin docs/next
gh pr create --base docs/lower --head docs/next --title "..." --body "Stacked on #<lower>."
```

After the lower PR merges into `main`, retarget the upper PR and merge `main` in (no rebase or force-push):

```bash
gh pr edit <upper> --base main
git fetch origin && git merge origin/main && git push
```

**Stacks are merged with merge commits, not squash.** That keeps the upper PRs' history intact, so retargeting and merging `main` stay clean.

## 6. Merge order

Open PRs as of 2026-10-21 22:56 IST, from `gh pr list --state open`. Stacks merge with **merge commits, not squash**.

### Docs stack (merge in this order)

| Order | PR  | Branch                           | Base                             |
| ----- | --- | -------------------------------- | -------------------------------- |
| 1     | #3  | `docs/agent-board-and-providers` | `main`                           |
| 2     | #8  | `docs/getting-started`           | `main`                           |
| 3     | #12 | `docs/database-and-devops`       | `docs/getting-started`           |
| 4     | #14 | `docs/storage-testing-extension` | `docs/database-and-devops`       |
| 5     | #18 | `docs/contributing`              | `docs/storage-testing-extension` |
| 6     | #23 | `docs/contracts`                 | `docs/contributing`              |

Each docs PR already contains #3 merged up through the stack, so each one is mergeable against its base. After each PR merges, retarget the next one with `gh pr edit <n> --base main`.

### Other open PRs

| PR  | Owner      | Branch                            | Base                        | Confirmed dependency                              |
| --- | ---------- | --------------------------------- | --------------------------- | ------------------------------------------------- |
| #4  | SEC        | `docs/security-threat-model`      | `main`                      | None                                              |
| #5  | NATIVE     | `feat/extension-scaffold`         | `main`                      | None                                              |
| #6  | DB         | `feat/database-core-schema`       | `main`                      | None                                              |
| #7  | OPS        | `chore/devops-containers-ci`      | `main`                      | None                                              |
| #9  | QA         | `test/qa-harness`                 | `main`                      | None                                              |
| #10 | MEDIA      | `feat/storage-and-media-core`     | `main`                      | None                                              |
| #11 | INT        | `feat/notifications-email`        | `main`                      | None                                              |
| #13 | FE         | `feat/web-shell`                  | `main`                      | None                                              |
| #15 | NATIVE     | `feat/extension-capture`          | `feat/extension-scaffold`   | Stacked on #5; merge #5 first                     |
| #16 | MEDIA      | `feat/realtime-scaffold`          | `main`                      | None                                              |
| #17 | ARCH       | `feat/core-contracts`             | `main`                      | None                                              |
| #19 | INT        | `feat/integrations-webhooks-jira` | `main`                      | None                                              |
| #21 | AI         | `feat/ai-provider-registry`       | `main`                      | None                                              |
| #22 | ARCH       | `docs/adr-004`                    | `main`                      | ADR-004 references ADR-003 (#17); merge #17 first |
| #24 | OPS | `fix/eslint-project-service`      | `main`                      | None                                              |
| #25 | DB         | `feat/database-tenancy-rls`       | `feat/database-core-schema` | Stacked on #6; merge #6 first                     |
| #26 | OPS        | `chore/commitlint`                | `main`                      | None                                              |

"Confirmed" means a stacked base or an explicit reference in the PR. Logical dependencies are in the [dependency graph](../17-agents/dependency-graph.md), marked as assumptions. Many PRs touch `pnpm-lock.yaml`; resolve conflicts with the pinned pnpm, without reformatting.
