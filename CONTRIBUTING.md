# Contributing to MeetOps AI

New here? Start with [getting started](docs/00-getting-started/README.md). Agents must also follow the [agent workflow](docs/00-getting-started/agent-workflow.md) and the [execution rules](docs/17-agents/execution-rules.md).

## Branches

`feat/*`, `fix/*`, `chore/*`, `docs/*`, `test/*`. One branch per task. During Phase 1, open the PR against `integration/phase-1` (or against the branch below it when stacked), not `main`. See [Phase 1 integration branch](#phase-1-integration-branch).

## Phase 1 integration branch

Phase 1 work merges through `integration/phase-1`, not directly into `main`:

1. Target `integration/phase-1`: `gh pr create --base integration/phase-1 ...`.
2. A PR merges into `integration/phase-1` only after CI passes and Architecture and Security review approve it. Use merge commits, not squash.
3. Akash merges `integration/phase-1` into `main` through an integration PR (so far #30 and #112, both merged). Agents never merge into `main`.
4. To catch up, merge `origin/integration/phase-1` into your branch, not `origin/main`. Don't rebase or force-push.

## Commits

Use [Conventional Commits](https://www.conventionalcommits.org/): `feat:`, `fix:`, `chore:`, `docs:`, `ci:`, `refactor:`, `test:`, with an optional scope (for example `docs(agents): ...`). Keep commits small.

Commitlint enforces this through the Husky `commit-msg` hook (`commitlint.config.cjs`); for example, body and footer lines must be 100 characters or fewer.

## Tooling

- Node `>=20.19 <25` (`engines.node`); CI builds on Node 22 and 24.
- pnpm **9.12.3**, pinned in `packageManager` and installed through Corepack:

  ```bash
  corepack enable
  corepack prepare pnpm@9.12.3 --activate
  pnpm --version   # 9.12.3
  ```

- Install with `pnpm install` and commit `pnpm-lock.yaml` only when dependencies change. **Don't regenerate, re-resolve or reformat the lockfile.** In CI and clean clones use `pnpm install --frozen-lockfile`.

## Git rules

- **Never use `--no-verify`.** The Husky pre-commit hook runs `pnpm lint-staged` (ESLint on code, Prettier on md/json/yml). If it fails, fix the cause.
- **Never force-push a pushed branch.** To catch up, merge the base branch in (`git fetch origin && git merge origin/integration/phase-1`), then push.
- Never commit `.env` or secret values.

## Before opening a PR

Run from the repo root:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

All four scripts exist in the root `package.json` (via Turborepo). The repo has no separate format-check script. For docs, run `npx prettier --check <files>`. In the PR description, report the real results, including anything you didn't run.

## Local development

See [local setup](docs/00-getting-started/local-setup.md): copy `.env.example` to `.env`, run `pnpm install`, `pnpm dev:infra:up`, then `pnpm dev`.

## Stacked PRs and merge order

Stacked PRs are merged with merge commits, not squash.

See [agent workflow](docs/00-getting-started/agent-workflow.md#5-stacked-prs).
