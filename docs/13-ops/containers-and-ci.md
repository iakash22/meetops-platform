# Containers and CI (Phase 1, P1-OPS)

> **Note:** This page describes **open PR #7** (`chore/devops-containers-ci`), which is not merged yet. Source: head commit `4db524574996ef7db186faf9be49ab721172316b`, read via `gh pr view 7` / `gh pr diff 7`. Update this page if the PR changes before merge.

## Docker images (`infra/docker/`)

| Image  | Dockerfile                          | Base                                                            | Runs as | Port | Healthcheck                 |
| ------ | ----------------------------------- | --------------------------------------------------------------- | ------- | ---- | --------------------------- |
| api    | `Dockerfile.api`                    | `node:${NODE_VERSION}-bookworm-slim` (20.18.0), multi-stage     | `node`  | 3000 | `/health`                   |
| worker | `Dockerfile.worker`                 | same, runtime adds FFmpeg and tini                              | `node`  | None | None (no HTTP endpoint yet) |
| web    | `Dockerfile.web` + `nginx/web.conf` | Vite build, served by `nginxinc/nginx-unprivileged:1.27-alpine` | UID 101 | 8080 | `/healthz`, SPA fallback    |

Build pattern (api/worker): pnpm 9.12.3 via Corepack → `pnpm install --frozen-lockfile --ignore-scripts` → `pnpm --filter <app>... build` → `pnpm deploy --prod`.

A root `.dockerignore` excludes `node_modules`, `dist`, `.git`, `.env*` and keys.

## compose.app.yml

`infra/compose/compose.app.yml` adds `api`, `worker` and `web` on top of `compose.dev.yml`:

```bash
docker compose --env-file .env -f infra/compose/compose.dev.yml -f infra/compose/compose.app.yml up -d --build
```

- Builds with context at the repo root. Images are tagged `meetops/<app>:local`.
- `env_file: .env` (required), then overrides infra URLs to service names: `postgres:5432`, `redis:6379`, `minio:9000`, `ollama:11434`, `local-stt:8000`. `NODE_ENV=production`.
- Ports: api `${API_PORT:-3000}`, web `${WEB_PORT:-8080}`. The worker has none.
- api and worker wait for healthy postgres and redis and for `minio-init` to complete. web waits for api to start.

## CI

| Workflow            | Job                             | What it does                                                                                                               |
| ------------------- | ------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `ci.yml` (existing) | `build`                         | Phase 0 lint, typecheck, test and build                                                                                    |
| `ci.yml` (new)      | `audit`                         | `pnpm audit --prod --audit-level high`, `continue-on-error: true` (non-blocking) until apps/api moves to fastify >= 5.12.2 |
| `docker.yml` (new)  | `build` (matrix api/worker/web) | Buildx build with `push: false`, GHA cache scoped per image; runs on PRs and pushes to `main`                              |

Also in the PR: `.github/dependabot.yml` (weekly npm, github-actions and docker updates) and `.github/CODEOWNERS` (`@iakash22` everywhere, with comments naming the responsible agent per folder).

## Known gaps (from the PR)

- Images haven't been built or run locally yet; the `Docker` workflow is the first real build.
- The compose app stack hasn't been started.
- `--ignore-scripts` skips `prisma generate`. That's fine while api/worker don't import `@meetops/database`, but it must change once they do (see PR #6).
- The audit currently reports 12 advisories (7 high) in fastify 4.x and related packages.
