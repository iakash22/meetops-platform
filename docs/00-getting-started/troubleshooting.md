# Troubleshooting

## OneDrive and synced folders (Windows)

Keep the repo out of OneDrive, Dropbox and other synced folders (for example `Documents` or `Desktop` when OneDrive backup is on). Syncing `node_modules`, `.turbo` and Docker bind mounts causes file locks, slow installs and `EPERM`/`EBUSY` errors. Use `C:\dev\meetops-platform`.

## WSL 2

Docker Desktop on Windows needs the WSL 2 backend.

- Check with `wsl --status`. Install or update with `wsl --install` / `wsl --update`, then reboot.
- Enable virtualization in BIOS/UEFI if WSL reports it's missing.
- If you work inside a WSL distro instead, clone into the Linux filesystem (`~/...`), not `/mnt/c`, and follow the Linux steps.

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
