# Local setup

Check the [prerequisites](prerequisites.md) first. All commands run from the repo root.

## Windows (C:\dev)

Use PowerShell with Docker Desktop running. Keep the repo in `C:\dev`, outside OneDrive or any other synced folder (see [troubleshooting](troubleshooting.md)).

```powershell
mkdir C:\dev -Force
cd C:\dev
git clone https://github.com/iakash22/meetops-platform.git
cd meetops-platform
corepack enable
Copy-Item .env.example .env      # fill in local values; never commit .env
pnpm install
sh scripts/gen-dev-secrets.sh --from-env   # compose secrets from .env (sh from Git for Windows)
pnpm dev:infra:up                # Postgres, Redis, MinIO (+ bucket init)
pnpm dev                         # api, web, worker via turbo
```

## Linux

```bash
git clone https://github.com/iakash22/meetops-platform.git
cd meetops-platform
corepack enable
cp .env.example .env             # fill in local values; never commit .env
pnpm install
./scripts/gen-dev-secrets.sh --from-env   # compose secrets in infra/compose/secrets (gitignored)
pnpm dev:infra:up
pnpm dev
```

## Root scripts

| Script                                       | What it runs                                                                                 |
| -------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `pnpm docker:ensure`                         | Start Docker Desktop if needed and wait until the engine is ready                            |
| `pnpm dev:infra:up`                          | `docker:ensure` then `docker compose --env-file .env -f infra/compose/compose.dev.yml up -d` |
| `pnpm dev:infra:down`                        | `docker:ensure` then `... down`                                                              |
| `pnpm dev:infra:logs`                        | `docker:ensure` then `... logs -f`                                                           |
| `pnpm dev`                                   | `turbo run dev`                                                                              |
| `pnpm build` / `lint` / `typecheck` / `test` | `turbo run <task>`                                                                           |

Optional profiles: `docker compose --env-file .env -f infra/compose/compose.dev.yml --profile ollama --profile local-stt up -d`.

## Verify

- `docker compose -f infra/compose/compose.dev.yml ps` shows postgres, redis and minio as healthy.
- MinIO console: http://localhost:9001.
- API listens on port 3000 and web on http://localhost:5173.

Secrets such as `SMTP_PASSWORD`, `GEMINI_API_KEY` and `ASSEMBLYAI_API_KEY` stay empty until provided; see `docs/17-agents/credential-requests.md` and [environment variables](environment-variables.md).
