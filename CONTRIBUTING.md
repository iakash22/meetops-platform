# Contributing to MeetOps AI

New here? Start with [getting started](docs/00-getting-started/README.md). Agents must also follow the [agent workflow](docs/00-getting-started/agent-workflow.md) and the [execution rules](docs/17-agents/execution-rules.md).

## Branches

`feat/*`, `fix/*`, `chore/*`, `docs/*`, `test/*`. One branch per task, opened as a PR to `main` (or to the branch below it when stacked).

## Commits

Use [Conventional Commits](https://www.conventionalcommits.org/): `feat:`, `fix:`, `chore:`, `docs:`, `ci:`, `refactor:`, `test:`, with an optional scope (for example `docs(agents): ...`). Keep commits small.

The repo has no commitlint config, so the format isn't enforced by a hook; reviewers check it.

## Tooling

- Node `>=20.10.0 <23` (`engines.node`).
- pnpm **9.12.3**, pinned in `packageManager` and installed through Corepack:

  ```bash
  corepack enable
  corepack prepare pnpm@9.12.3 --activate
  pnpm --version   # 9.12.3
  ```

- Install with `pnpm install` and commit `pnpm-lock.yaml` only when dependencies change. **Don't regenerate, re-resolve or reformat the lockfile.** In CI and clean clones use `pnpm install --frozen-lockfile`.

## Git rules

- **Never use `--no-verify`.** The Husky pre-commit hook runs `pnpm lint-staged` (ESLint on code, Prettier on md/json/yml). If it fails, fix the cause.
- **Never force-push a pushed branch.** To catch up with `main`, run `git fetch origin && git merge origin/main`, then push.
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

See [agent workflow](docs/00-getting-started/agent-workflow.md#stacked-prs).
