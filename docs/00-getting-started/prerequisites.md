# Prerequisites

Versions come from the root `package.json`.

| Tool                       | Version                                    | Notes                                                                              |
| -------------------------- | ------------------------------------------ | ---------------------------------------------------------------------------------- |
| Node.js                    | `^20.19 \|\| >=22.12 <25` (`engines.node`) | Node 22 or 24 (CI matrix); 20.19+ or 22.12+ (no Node 21)                           |
| pnpm                       | `9.12.3` (`packageManager`)                | Enable with Corepack: `corepack enable`                                            |
| Git                        | Any recent version                         |                                                                                    |
| Docker + Docker Compose v2 | Recent                                     | Docker Desktop on Windows (WSL 2 backend); Docker Engine + compose plugin on Linux |
| FFmpeg                     | Recent                                     | Needed by the media pipeline                                                       |

## Ports used locally

| Port  | Service                                                                                                    | Source                                         |
| ----- | ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| 5432  | PostgreSQL (pgvector, pg16)                                                                                | `POSTGRES_PORT` (default 5432), `DATABASE_URL` |
| 6379  | Redis                                                                                                      | `REDIS_PORT` (default 6379), `REDIS_URL`       |
| 9000  | MinIO S3 API                                                                                               | `STORAGE_ENDPOINT`                             |
| 9001  | MinIO console                                                                                              | compose                                        |
| 11434 | Ollama (optional `ollama` profile)                                                                         | `OLLAMA_BASE_URL`                              |
| 8001  | Local STT (optional `local-stt` profile): host `8001` → container `8000` (`infra/compose/compose.dev.yml`) | `LOCAL_STT_URL` (`http://localhost:8001`)      |
| 3000  | API (`apps/api`)                                                                                           | `PORT` (default 3000)                          |
| 5173  | Web (`apps/web`, Vite)                                                                                     | `apps/web/vite.config.ts`                      |

Next: [local setup](local-setup.md).
