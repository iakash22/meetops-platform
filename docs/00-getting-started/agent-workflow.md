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

Open PRs as of 2026-10-21, from `gh pr list --state open`.

### Docs stack (merge in this order)

| Order | PR  | Branch                           | Base                                                                   |
| ----- | --- | -------------------------------- | ---------------------------------------------------------------------- |
| 1     | #3  | `docs/agent-board-and-providers` | `main`                                                                 |
| 2     | #8  | `docs/getting-started`           | `main` (confirmed depends on #3: shares the implementation board file) |
| 3     | #12 | `docs/database-and-devops`       | `docs/getting-started`                                                 |
| 4     | #14 | `docs/storage-testing-extension` | `docs/database-and-devops`                                             |
| 5     | #18 | `docs/contributing`              | `docs/storage-testing-extension`                                       |

### Other open PRs

| PR  | Branch                        | Base                      | Confirmed dependency                                                                 |
| --- | ----------------------------- | ------------------------- | ------------------------------------------------------------------------------------ |
| #17 | `feat/core-contracts`         | `main`                    | None (ARCH; logical upstream of others, see graph)                                   |
| #16 | `feat/realtime-scaffold`      | `main`                    | None (MEDIA)                                                                         |
| #4  | `docs/security-threat-model`  | `main`                    | None                                                                                 |
| #5  | `feat/extension-scaffold`     | `main`                    | None                                                                                 |
| #15 | `feat/extension-capture`      | `feat/extension-scaffold` | Stacked on #5; merge #5 first                                                        |
| #6  | `feat/database-core-schema`   | `main`                    | None                                                                                 |
| #7  | `chore/devops-containers-ci`  | `main`                    | None confirmed. Its images skip `prisma generate`, which matters once apps import #6 |
| #9  | `test/qa-harness`             | `main`                    | None                                                                                 |
| #10 | `feat/storage-and-media-core` | `main`                    | None                                                                                 |
| #11 | `feat/notifications-email`    | `main`                    | None                                                                                 |
| #13 | `feat/web-shell`              | `main`                    | None                                                                                 |

"Confirmed" means the PR base or a shared file. Logical dependencies are in [dependency graph](../17-agents/dependency-graph.md) and marked as assumptions. Several PRs (#5, #6, #9, #10) touch `pnpm-lock.yaml`, so expect lockfile conflicts as they land; resolve them with `pnpm install` at the pinned version, without reformatting.
