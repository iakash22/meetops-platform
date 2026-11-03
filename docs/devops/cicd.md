# CI/CD pipeline

> **Status: proposal, not running.** GitHub Actions minutes are exhausted, and the local gate is CI
> (`pnpm local-gates` + `gitleaks`, see [local-gates.md](../local-gates.md)). `cd.yml` is inert
> until the repository variable `CD_ENABLED` is set to `true`. Until then, its jobs are skipped
> and use no runner minutes. Set the variable only after minutes are back and Akash approves.

| Workflow      | Trigger                                               | Purpose                                                           |
| ------------- | ----------------------------------------------------- | ----------------------------------------------------------------- |
| `ci.yml`      | push to `main`/`integration/**`, all PRs              | lint, typecheck, test, build, audit, Prisma live tests            |
| `docker.yml`  | same as CI                                            | build per-app images (api, worker, web, realtime) without pushing |
| `qa.yml`      | see file                                              | QA checks                                                         |
| `secrets.yml` | see file                                              | gitleaks secret scan                                              |
| `cd.yml`      | push to `main`/`integration/phase-1`; manual dispatch | publish images to GHCR; gated deploy (placeholder)                |

## Publish (automatic)

With `CD_ENABLED=true`, on push to `main` or `integration/phase-1` (non-docs changes), `cd.yml` builds each
`infra/docker/Dockerfile.<app>` and pushes to `ghcr.io/<owner>/<repo>/<app>` with tags:

- `sha-<full commit sha>` (immutable, use for deploys)
- branch name, sanitized (`main`, `integration-phase-1`) (moving)

Auth uses the built-in `GITHUB_TOKEN` with `packages: write`; no extra secrets.

## Deploy (manual, placeholder)

Requires `CD_ENABLED=true`. Actions → CD → Run workflow → choose `staging` or `production` and optionally an image tag
(defaults to `sha-<selected ref sha>`). Tick `publish` to build that ref first. The job runs in the matching GitHub environment, so
configure required reviewers there (at least on `production`). The deploy step currently only
prints what it would do — no infrastructure exists yet.

Secrets to add as **environment secrets** once a target exists: `DEPLOY_HOST`/`DEPLOY_TARGET`,
`DEPLOY_CREDENTIALS` (prefer OIDC), `DATABASE_URL` (for `prisma migrate deploy`). App runtime
config belongs in the hosting platform, not CI.
