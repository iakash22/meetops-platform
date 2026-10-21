# Containers and CI (Phase 1, P1-OPS)

> **Note:** This page describes **open, unmerged PR #7** (`chore/devops-containers-ci`, base `integration/phase-1`) at head `23b8240d36e05a489e2a5930977aee7d30837aa5`, read via `gh pr view 7 --json headRefOid` / `gh pr diff 7`. Update it if the PR changes before merge.

## Docker images (`infra/docker/`)

All Node images use `node:${NODE_VERSION}-bookworm-slim` (`NODE_VERSION=20.20.2`) with pinned base images and pnpm from `packageManager` (9.12.3).

| Image | Dockerfile | Runs as | Port | Healthcheck | Notes |
| --- | --- | --- | --- | --- | --- |
| api | `Dockerfile.api` (target `runtime`) | `node` | 3000 | `/health` on `PORT` | Generates the Prisma client; installs OpenSSL |
| migrate | `Dockerfile.api` (target `migrate`) | `node` | None | None | Runs `db:migrate:deploy && db:seed`, then exits; keeps the full workspace |
| worker | `Dockerfile.worker` | `node` | None | None | Pinned FFmpeg (`FFMPEG_VERSION`), tini, OpenSSL; Prisma client |
| realtime | `Dockerfile.realtime` | `node` | 4001 | Yes (`/health` on `REALTIME_PORT`) | For `apps/realtime` **(requires PR #16, unmerged)** |
| web | `Dockerfile.web` + `nginx/web.conf.template` | nginx-unprivileged `1.27.5-alpine` | 8080 | Yes | `VITE_API_URL` build arg (default `http://localhost:3000`); strict CSP and security headers via an envsubst template |

The root `.dockerignore` excludes `node_modules`, `dist`, `.git`, `.env*` and keys.

## compose.dev.yml (changes in #7)

- No credential fallbacks: `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB` and `REDIS_PASSWORD` are required. Redis runs with `requirepass`.
- Images are pinned (no `:latest`), and all host ports bind to `127.0.0.1`.
- Ports: Postgres `${POSTGRES_PORT:-5432}`, Redis `${REDIS_PORT:-6379}`, object storage `${MINIO_API_PORT:-9000}` / `${MINIO_CONSOLE_PORT:-9001}`, Ollama 11434 and local STT **8000** (changed from 8001 to match AI PR #21).
- `minio-init` restricts bucket CORS to `WEB_ORIGIN` and adds lifecycle (ILM) rules.

## compose.app.yml

```bash
docker compose --env-file .env -f infra/compose/compose.dev.yml -f infra/compose/compose.app.yml up -d --build
```

Dev-only. The services:

- `migrate`: one-shot; gates `api` and `worker`.
- `api`: `127.0.0.1:${API_PORT:-3000}`.
- `worker`: read-only root, tmpfs scratch at `/tmp/work`, `cap_drop: [ALL]`, `mem_limit: 2g`.
- `realtime`: behind the `realtime` profile until #16 merges; `127.0.0.1:${REALTIME_PORT:-4001}`, read-only, 512 MB.
- `web`: `127.0.0.1:${WEB_APP_PORT:-8080}`.

Infra URLs are overridden to service names, and `DATABASE_URL` is built from `POSTGRES_*`.

## CI

| Workflow | Job | What it does |
| --- | --- | --- |
| `ci.yml` | `build` | Corepack pnpm, Node 20, `pnpm install --frozen-lockfile`, **lockfile drift check** (`git diff --exit-code pnpm-lock.yaml`), then lint, typecheck, test and build |
| `ci.yml` | `audit` | `pnpm audit --prod --audit-level high`, `continue-on-error` as a **dated exception expiring 2026-11-04** |
| `docker.yml` | `build` (matrix api, worker, web, realtime) | Buildx with `push: false` and GHA cache per image; realtime is skipped when `apps/realtime` is absent |
| `secrets.yml` (new) | Secret scan | `gitleaks detect` over full history (`--redact`) |

All workflows run on `pull_request` (any base, including `integration/phase-1`) and on pushes to `main`. Actions are pinned to commit SHAs, and permissions are least-privilege per job.

Also in #7: `.github/dependabot.yml` (weekly npm, actions and docker updates); `.github/CODEOWNERS` (`@iakash22`, plus Architecture-owned paths `packages/contracts`, `docs/02*` and `docs/15*`); and a gitleaks pre-commit hook (`scripts/hooks/pre-commit`, installed with `scripts/install-git-hooks.sh`; skips with a warning if gitleaks isn't installed).

## Known gaps

- CI runs **Node 20 only**. The Coordinator's decision to test on Node 22 and 24 (and widen `engines` to `<25`) is a pending DevOps change.
- `compose.app.yml` gives `migrate` and `api` the superuser `DATABASE_URL` and doesn't set `MIGRATION_DATABASE_URL`. With #25 this doesn't match the two-role model (migrator for migrations, `meetops_app` at runtime), and the app would connect as a role that isn't subject to RLS. Routed to DevOps and DB.
- No image builds or container runs had been verified locally when the PR was opened; the `Docker` workflow is the first real build.
