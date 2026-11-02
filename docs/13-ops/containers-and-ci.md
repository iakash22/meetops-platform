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

## ClamAV sidecar (`clamav`, ADR-018)

There are no production deployment manifests in this repo yet. The `clamav` service in `compose.app.yml`
(profile `clamav`) and `infra/clamav/*.conf` are the reference spec, and every deployment (compose, Kubernetes,
ECS, ...) must copy these settings:

| Setting    | Value                                                                                                                          | Why                                                                                                                                                           |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Image      | `clamav/clamav:1.4.6@sha256:8ad6197396974726c35d017e50aaaaf4b91745726a04faec8480c203edd98052`                                  | Version and digest pinned. 1.4 is the ClamAV LTS line. Bump tag and digest together                                                                           |
| Config     | `infra/clamav/clamd.conf` → `/etc/clamav/clamd.conf`, `infra/clamav/freshclam.conf` → `/etc/clamav/freshclam.conf` (read-only) | `StreamMaxLength`/`MaxFileSize`/`MaxScanSize` 1400M, `AlertExceedsMax yes`, `MaxScanTime 600000`                                                              |
| Updates    | `FRESHCLAM_CHECKS=1` (freshclam daemon started by the image's `/init`)                                                         | Signatures update daily. freshclam needs egress to `database.clamav.net`; the worker does not                                                                 |
| Database   | Persistent volume at `/var/lib/clamav`                                                                                         | No re-download on restart (ClamAV rate-limits mirrors)                                                                                                        |
| Memory     | `mem_limit: 4g`, `ConcurrentDatabaseReload yes`                                                                                | One engine measured at about 1.1–1.3 GB RSS during a 1.4 GB scan. A reload holds two engines for a short time. Blocking reload would stall scans and `/ready` |
| Health     | `clamdcheck.sh` (PING → PONG on TCP 3310), `start_period: 360s`                                                                | Loading signatures takes 10–60 s                                                                                                                              |
| Network    | Reachable from the worker on TCP 3310 (`media-internal`). No public port                                                       | The worker stays egress-free                                                                                                                                  |
| Worker env | `UPLOAD_SCAN_CLAMAV=true`, `CLAMD_HOST`, `CLAMD_PORT`                                                                          | Fail-closed scan of every upload and recording                                                                                                                |
| Disk       | About 1.5 GB free in the container's `/tmp` per concurrent scan                                                                | clamd spools each INSTREAM body to `TemporaryDirectory` before it scans                                                                                       |

Dev: `UPLOAD_SCAN_CLAMAV=true scripts/compose-up.sh --profile clamav`. The worker then waits for clamd to report
healthy. Without the profile, the worker starts as usual with the scan off.

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

## Media worker temp disk (tmpfs) sizing

The upload cap for a media source is 2 GB (docs/12-security/upload-media-security.md).
The worker writes the source and its derived files (normalised audio, ffmpeg scratch)
to `MEDIA_TMP_DIR=/tmp/work`, a tmpfs. It is sized at **3 GB**: the 2 GB source plus
up to 1 GB of derived output. A 2 GB tmpfs (the previous value) would hit ENOSPC on a
max-size upload before any output is written.

tmpfs pages count against the container memory cgroup, so `mem_limit` is **4 GB**
(3 GB tmpfs + about 1 GB for node and ffmpeg). Change both values together. If the
source cap grows, raise tmpfs and `mem_limit` by the same amount, or move
`/tmp/work` to a size-limited volume.
