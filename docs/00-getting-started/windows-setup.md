# Windows local setup (Akash's machine)

Target: Windows with WSL 2 (Ubuntu), Docker Desktop on the WSL 2 backend, Node 24, Corepack with pnpm 9.12.3, and Git. The general steps are in [local setup](local-setup.md); this page covers Windows specifics. For other problems, see [troubleshooting](troubleshooting.md).

Steps marked **(requires PR #N, unmerged)** depend on an open PR and won't work on `main` until it merges. Values come from `main` and the open PRs as of 2026-10-21. PR heads read: #6 `62c7b89`, #7 `9e1d407`, #16 `9d18f47`, #25 `30f542a`.

> [!NOTE]
> **Node 24 is supported.** `engines.node` is `"^20.19 || >=22.12 <25"` and CI builds on a Node `[22, 24]` matrix (PR #32). Node 22 LTS also works ([nvm-windows](https://github.com/coreybutler/nvm-windows) or [fnm](https://github.com/Schniz/fnm)).

> **Known gaps, routed to owners:**
>
> - DevOps: adding `.gitattributes`, `MIGRATION_DATABASE_URL` missing from `.env.example`, `API_PORT` vs the api's `PORT`, and the Linux-only `FFMPEG_PATH` default in #7's `.env.example`.
> - DB: a script for local LOGIN/password setup of `meetops_app` / `meetops_migrator` (section 6).

## 1. Install the tools

| Tool            | How                                                                                                          |
| --------------- | ------------------------------------------------------------------------------------------------------------ |
| WSL 2 + Ubuntu  | `wsl --install -d Ubuntu`, reboot, then `wsl --status` should show default version 2                         |
| Docker Desktop  | Settings → General → "Use the WSL 2 based engine"; Resources → WSL integration → enable Ubuntu if you use it |
| Git for Windows | `winget install Git.Git`                                                                                     |
| Node            | 24 or 22 LTS; see the note above                                                                             |
| pnpm 9.12.3     | `corepack enable`, then `corepack prepare pnpm@9.12.3 --activate`, then `pnpm --version`                     |
| FFmpeg          | `winget install Gyan.FFmpeg` (needed by media-core tests and the worker)                                     |

## 2. Line endings (before cloning)

```powershell
git config --global core.autocrlf input   # or: false
```

- `input` converts CRLF to LF on commit and never adds CRLF on checkout; `false` leaves files untouched. Both keep LF in the working tree.
- Avoid `true` (the Git for Windows default). It checks files out as CRLF, which breaks shell scripts and Husky hooks (`.husky/pre-commit` gets `/usr/bin/env: 'sh\r'`), Dockerfile `RUN` heredocs and the compose `minio-init` entrypoint inside Linux containers. It also produces whole-file Prettier/ESLint diffs.
- The repo's `.editorconfig` sets the style, but **the repo has no `.gitattributes`** on `main` or in any open PR. Adding one is recommended (not done here) so line endings don't depend on each machine's settings, e.g. `* text=auto eol=lf` plus `*.png binary`-style entries for binaries. Routed to DevOps.

## 3. Clone to `C:\dev`, not OneDrive

```powershell
mkdir C:\dev -Force
cd C:\dev
git clone https://github.com/iakash22/meetops-platform.git
cd meetops-platform
```

Why not OneDrive (`Documents`, `Desktop` when backup is on):

- **Sync locks:** OneDrive opens files to upload them, so pnpm, Prisma and TypeScript writes hit `EPERM`/`EBUSY`.
- **File-watcher churn:** `node_modules`, `.turbo` and `dist` hold tens of thousands of files. Sync and `tsx watch`/Vite watchers fight each other, pegging the CPU and triggering spurious reloads.
- **Path length:** OneDrive paths are long (`C:\Users\<name>\OneDrive - <org>\...`), and pnpm's nested `node_modules/.pnpm/...` paths can exceed the 260-character limit. Also run `git config --global core.longpaths true`.
- **Placeholder files:** "Files On-Demand" replaces files with cloud placeholders, so tools find stubs or trigger downloads mid-build.

If you'd rather work inside WSL, clone into the Linux filesystem (`~/dev/meetops-platform`), not `/mnt/c`, and follow the Linux steps in [local setup](local-setup.md).

## 4. Environment

```powershell
Copy-Item .env.example .env
pnpm install --frozen-lockfile
```

Fill in `.env` locally and never commit it. **(requires PR #7, unmerged)**: #7 makes `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB` and `REDIS_PASSWORD` required (no compose fallbacks), and adds `REDIS_URL` with the password and the port vars below. Choose your own local values.

## 5. Start the infra

```powershell
pnpm docker:ensure    # opens Docker Desktop if needed, waits until ready
pnpm dev:infra:up     # ensure-docker + compose up -d (infra/compose/compose.dev.yml)
docker compose -f infra/compose/compose.dev.yml ps
```

`dev:infra:up` already runs `docker:ensure`. This starts Postgres (pgvector pg16), Redis, MinIO and `minio-init` (bucket creation). Stop it with `pnpm dev:infra:down`, and follow logs with `pnpm dev:infra:logs`.

## 6. Database: migrations with two roles

**(requires PR #6 and PR #25, unmerged; #25 is stacked on #6)**

#25 adds two roles in migration `20261021110000_tenant_rls_roles`:

| Role               | Purpose                                                     | Env var                                       |
| ------------------ | ----------------------------------------------------------- | --------------------------------------------- |
| `meetops_migrator` | Owns schema objects; runs `migrate deploy` and seed         | `MIGRATION_DATABASE_URL` (Prisma `directUrl`) |
| `meetops_app`      | App runtime: DML only, `NOBYPASSRLS`, subject to forced RLS | `DATABASE_URL`                                |

Both roles are created as **NOLOGIN**. Per #25, passwords and LOGIN are set "out of band, never in SQL" (in migrations). Both URLs are required for `prisma validate` and `migrate`.

Local procedure (my reading of #25; not scripted in the PR, and a script has been requested from DB):

1. For the first migrate, point `MIGRATION_DATABASE_URL` at the compose superuser (`POSTGRES_USER`), because the roles don't exist yet.
2. Run the migrations:

   ```powershell
   pnpm --filter @meetops/database db:migrate:deploy
   ```

3. Give both roles LOGIN with passwords you choose locally (placeholders shown; don't commit real values):

   ```powershell
   docker compose -f infra/compose/compose.dev.yml exec postgres psql -U <POSTGRES_USER> -d <POSTGRES_DB> -c "ALTER ROLE meetops_migrator LOGIN PASSWORD '<local-pw>'; ALTER ROLE meetops_app LOGIN PASSWORD '<local-pw>';"
   ```

4. Set `MIGRATION_DATABASE_URL` to `meetops_migrator` and `DATABASE_URL` to `meetops_app` in `.env`.
5. Seed (#25: "run the seed as migrator"):

   ```powershell
   pnpm --filter @meetops/database db:seed    # prisma db seed, which runs tsx prisma/seed.ts
   ```

On #6 alone (without #25), there's a single `DATABASE_URL`: run `db:migrate:deploy` (or `db:migrate:dev`) and `db:seed`.

## 7. Run the apps

```powershell
pnpm dev:stack                              # api + web + worker (usual local loop)
pnpm dev                                    # every package with a dev script
```

Or run one app per terminal:

| App       | Command              | Port                           |
| --------- | -------------------- | ------------------------------ |
| api       | `pnpm dev:api`       | `PORT` (default 3000)          |
| web       | `pnpm dev:web`       | 5173                           |
| worker    | `pnpm dev:worker`    | None                           |
| realtime  | `pnpm dev:realtime`  | `REALTIME_PORT` (default 4001) |
| desktop   | `pnpm dev:desktop`   | 1420                           |
| extension | `pnpm dev:extension` | 3000 (WXT)                     |

## 8. Port conflicts

| Port         | Service                                | Variable                                                                                |
| ------------ | -------------------------------------- | --------------------------------------------------------------------------------------- |
| 5432         | Postgres                               | `POSTGRES_PORT`                                                                         |
| 6379         | Redis                                  | `REDIS_PORT`                                                                            |
| 9000 / 9001  | MinIO API / console                    | fixed on `main`; `MINIO_API_PORT` / `MINIO_CONSOLE_PORT` **(requires PR #7, unmerged)** |
| 3000         | api                                    | `PORT` in code; `API_PORT` in #7's compose                                              |
| 5173         | web (Vite)                             | `WEB_PORT` (#7, #9)                                                                     |
| 8080         | web container                          | `WEB_APP_PORT` **(requires PR #7, unmerged)**                                           |
| 4001         | realtime                               | `REALTIME_PORT` **(requires PR #16, unmerged)**                                         |
| 11434 / 8001 | Ollama / local STT (optional profiles) | fixed; local STT maps host `8001` → container `8000` (`infra/compose/compose.dev.yml`)  |

Find what's holding a port:

```powershell
netstat -ano | findstr :5432
Get-NetTCPConnection -LocalPort 5432 -State Listen | Select-Object LocalPort, OwningProcess
Get-Process -Id (Get-NetTCPConnection -LocalPort 5432 -State Listen).OwningProcess
```

Common causes: a Windows PostgreSQL or Redis service (`Get-Service *postgres*`, then `Stop-Service`), or an old container (`docker ps`). Also check the Hyper-V/WSL reserved port ranges with `netsh interface ipv4 show excludedportrange protocol=tcp`; Docker can't bind ports inside them. Either free the port or change the variable in `.env`, and keep `DATABASE_URL` and `REDIS_URL` in sync.

## 9. Troubleshooting

See [troubleshooting](troubleshooting.md) for OneDrive, WSL 2, Docker Desktop and port issues. Windows-specific extras:

- **`sh\r` errors in hooks or containers:** a CRLF checkout. Set `core.autocrlf input`, then re-checkout with `git rm --cached -r . && git reset --hard`. That reset discards uncommitted changes, so commit or stash first.
- **`EPERM` or long-path errors on `pnpm install`:** move the repo out of OneDrive and enable `core.longpaths`, plus Windows long paths (`LongPathsEnabled` registry setting; needs admin).
- **pnpm "Unsupported engine" warning:** your Node is outside `engines.node` (`^20.19 || >=22.12 <25`); switch to Node 22 or 24.
- **Prisma "role does not exist" or "permission denied":** the migrations from #25 haven't run, or the LOGIN step was skipped (section 6).
