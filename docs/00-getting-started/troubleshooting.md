# Troubleshooting

## OneDrive and synced folders (Windows)

Keep the repo out of OneDrive, Dropbox and other synced folders (for example `Documents` or `Desktop` when OneDrive backup is on). Syncing `node_modules`, `.turbo` and Docker bind mounts causes file locks, slow installs and `EPERM`/`EBUSY` errors. Use `C:\dev\meetops-platform`.

## WSL 2

Docker Desktop on Windows needs the WSL 2 backend.

- Check with `wsl --status`. Install or update with `wsl --install` / `wsl --update`, then reboot.
- Enable virtualization in BIOS/UEFI if WSL reports it's missing.
- If you work inside a WSL distro instead, clone into the Linux filesystem (`~/...`), not `/mnt/c`, and follow the Linux steps.

## `pnpm dev` / missing `@meetops/*/dist`

Apps resolve workspace packages from `dist/` (for example `@meetops/contracts/dist/index.js`). `pnpm dev` runs `^build` first via Turbo. If you still see `ERR_MODULE_NOT_FOUND` for a package `dist`, run `pnpm build --filter=@meetops/contracts` (or `pnpm build`) and retry.

## API / worker crash on `pnpm dev:stack` (root `.env` not loaded)

These scripts load the **repo root** `.env` (copy from `.env.example` first):

| Package / command                                         | How env is loaded                                                                           |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `@meetops/api` / `worker` / `realtime` `dev`              | `tsx … --import ../../scripts/load-env-if-exists.mjs` (optional `.env`)                     |
| `@meetops/realtime` `start`                               | `node --import ../../scripts/load-env-if-exists.mjs` (optional `.env`)                      |
| `@meetops/database` `db:migrate:*`, `db:seed`, `db:roles` | `node` / `tsx` `--import ../../scripts/load-env-if-exists.mjs` (optional `.env`)            |
| `@meetops/web` `dev`                                      | Vite `envDir` = monorepo root; `/api` proxied to `PORT`/`API_PORT` when `VITE_API_URL=/api` |

Without `NODE_ENV=development` and `DATABASE_URL`, the API exits with `MissingProductionDependencyError` and the worker with `DATABASE_URL is required`. Extension uses `apps/extension/.env` (see its `.env.example`); desktop keeps Tauri’s fixed Vite port `1420`.

## Signup / API returns `INTERNAL` (`PrismaClientInitializationError`)

Usually the Postgres volume was first created **without** real secret files. Docker Compose then creates `infra/compose/secrets/*.txt` as **directories**, initdb never creates `meetops` / `meetops_app`, and Prisma fails on signup.

Fix (local only; **deletes DB volumes**):

```powershell
# remove secret directories if present, then:
bash scripts/gen-dev-secrets.sh --from-env
docker compose --env-file .env -f infra/compose/compose.dev.yml down -v
pnpm dev:infra:up
pnpm --filter @meetops/database db:migrate:deploy
```

Confirm roles with `docker exec meetops-dev-postgres-1 psql -U meetops -d meetops -c "\du"` (expect `meetops`, `meetops_app`, `meetops_migrator`).

## Docker Desktop

- `pnpm dev:infra:up` / `down` / `logs` run `scripts/ensure-docker.mjs` first. On Windows/macOS that opens Docker Desktop and waits (default 180s; override with `DOCKER_WAIT_MS`) until `docker info` succeeds.
- Pipe / daemon errors like `npipe:////./pipe/dockerDesktopLinuxEngine` mean the engine is not up yet — leave Desktop starting, or run `pnpm docker:ensure` alone.
- Under Settings → Resources → WSL integration, enable your distro if you run commands from WSL.
- A container is stuck unhealthy: run `pnpm dev:infra:logs`. To reset data, run `docker compose -f infra/compose/compose.dev.yml down -v`, which **deletes local volumes**.
- `.env` missing: the infra scripts pass `--env-file .env`, so copy `.env.example` to `.env` first.

## Port conflicts

Ports used: 5432, 6379, 9000, 9001, 3000, 5173, plus 11434 and 8001 with the optional profiles. Local STT maps host `8001` → container `8000` (`infra/compose/compose.dev.yml`).

- Find the process holding a port. Windows: `netstat -ano | findstr :5432`. Linux: `ss -ltnp | grep 5432`.
- Stop the conflicting service (for example a local PostgreSQL or Redis), or change the port.
- Postgres and Redis can be remapped with `POSTGRES_PORT` / `REDIS_PORT` in `.env`; also update `DATABASE_URL` / `REDIS_URL` to match.
- MinIO (9000/9001), Ollama and local STT ports are fixed in `compose.dev.yml`, so free the port instead.
