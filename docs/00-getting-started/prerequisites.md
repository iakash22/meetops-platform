# Prerequisites

Versions come from the root `package.json`.

| Tool                       | Version                          | Notes                                                                              |
| -------------------------- | -------------------------------- | ---------------------------------------------------------------------------------- |
| Node.js                    | `>=20.10.0 <23` (`engines.node`) | Node 20 or 22 LTS                                                                  |
| pnpm                       | `9.12.3` (`packageManager`)      | Enable with Corepack: `corepack enable`                                            |
| Git                        | Any recent version               |                                                                                    |
| Docker + Docker Compose v2 | Recent                           | Docker Desktop on Windows (WSL 2 backend); Docker Engine + compose plugin on Linux |
| FFmpeg                     | Recent                           | Needed by the media pipeline                                                       |

## Ports used locally

| Port  | Service                                                                                                                                                                           | Source                                         |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| 5432  | PostgreSQL (pgvector, pg16)                                                                                                                                                       | `POSTGRES_PORT` (default 5432), `DATABASE_URL` |
| 6379  | Redis                                                                                                                                                                             | `REDIS_PORT` (default 6379), `REDIS_URL`       |
| 9000  | MinIO S3 API                                                                                                                                                                      | `STORAGE_ENDPOINT`                             |
| 9001  | MinIO console                                                                                                                                                                     | compose                                        |
| 11434 | Ollama (optional `ollama` profile)                                                                                                                                                | `OLLAMA_BASE_URL`                              |
| 8000  | Local STT (optional `local-stt` profile): host `127.0.0.1:8000` → container `8000` per #7's head `23b8240` (requires PR #7, unmerged; `main` maps host `8001` → container `8000`) | `LOCAL_STT_URL` (`http://localhost:8000`)      |
| 3000  | API (`apps/api`)                                                                                                                                                                  | `PORT` (default 3000)                          |
| 5173  | Web (`apps/web`, Vite)                                                                                                                                                            | `apps/web/vite.config.ts`                      |

Next: [local setup](local-setup.md).
