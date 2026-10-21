# Testing

> **Note:** The `tests/` harness described here comes from **open PR #9** (`test/qa-harness`), which is not merged yet. Source: head commit `5195b0d21086b7df56ba6e609ecfe7f55e06b6c6`, read via `gh pr view 9` / `gh pr diff 9`. The PR also adds `tests/README.md`, which is the source of truth once merged.

## Layout

- **Unit tests** stay next to each package (`apps/*/test`, `packages/*/test`) and run with Vitest.
- **Cross-cutting suites** live in `tests/`, as the `@meetops/tests` workspace package (PR #9 adds `tests` to `pnpm-workspace.yaml`):

| Suite | Runner | What |
| --- | --- | --- |
| `tests/api` | Vitest project `api` | `/health`, `/ready` and 404 via Fastify `inject` on `createServer()`; real HTTP when `API_BASE_URL` is set |
| `tests/contract` | Vitest project `contract` | zod mirrors of `@meetops/contracts` types |
| `tests/factories` | Vitest project `factories` | Deterministic, seedable, tenant-aware factories |
| `tests/integration` | Vitest project `integration` | Testcontainers Postgres and Redis |
| `tests/e2e` | Playwright (chromium) | Smoke test against the web dev server |

## Prerequisites

- Node and pnpm as in [prerequisites](prerequisites.md), then `pnpm install` at the repo root.
- Integration tests need a running Docker daemon (Testcontainers). You don't need `pnpm dev:infra:up`; containers are started per suite.
- E2E needs Playwright browsers. Install them once with `pnpm --filter @meetops/tests e2e:install`.

## Commands

```bash
pnpm test                                       # all packages via turbo, incl. @meetops/tests (no e2e)
pnpm --filter @meetops/tests test               # all Vitest suites in tests/
pnpm --filter @meetops/tests test:unit          # factories project only
pnpm --filter @meetops/tests test:api
pnpm --filter @meetops/tests test:contract
pnpm --filter @meetops/tests test:integration   # needs Docker
pnpm --filter @meetops/tests e2e:install        # once: playwright install chromium
pnpm --filter @meetops/tests test:e2e           # starts apps/web dev server automatically
```

E2E isn't part of `pnpm test` or CI yet; run it explicitly.

## Environment variables

| Variable | Default | Used by |
| --- | --- | --- |
| `E2E_BASE_URL` | Unset: `http://localhost:$WEB_PORT`, and a dev server is started | e2e; when set, no server is started |
| `WEB_PORT` | `5173` | e2e dev server port |
| `API_BASE_URL` | Unset: in-process `inject` | api suite |
| `QA_SKIP_DOCKER` | Unset | `1` forces integration tests to skip |
| `QA_POSTGRES_IMAGE` / `QA_REDIS_IMAGE` | `postgres:16-alpine` / `redis:7-alpine` | integration |
| `CI` | None | Playwright retries (2), `forbidOnly`, HTML report |

## Docker skip behaviour

`isDockerAvailable()` runs `docker info`. When it fails, the integration suites are reported as **skipped**, not failed, and a warning is printed.

## Mock policy (from the PR)

- Mocks live only under `tests/` or a package's `test/`, never in `src/`.
- Prefer Testcontainers over mocks for Postgres and Redis.
- External services (AI, email, object storage) are mocked in CI.
- No paid API calls in CI, and no real credentials in fixtures.
