# MeetOps AI — QA harness (`tests/`)

Cross-cutting test suites live here as the standalone `@meetops/tests` package.

> **Not a pnpm workspace member.** `pnpm-workspace.yaml` is owned by Architecture and
> does not list `tests/`, so `tests/` has its own install and lockfile
> (`tests/pnpm-lock.yaml`, pnpm 9.12.3, `--ignore-workspace`). `@meetops/contracts` is
> linked with `link:../packages/contracts`; `apps/api` source is imported by relative path
> and resolves its deps from the root install. Consequence: root `pnpm lint/typecheck/test`
> (turbo) do **not** run `tests/`; run them from `tests/` (below) or add a CI step.
> Package-level unit tests stay next to their package (`apps/*/test`, `packages/*/test`).

## Layout

| Path                  | Runner                         | What                                                                                                                                 |
| --------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| `api/`                | vitest (`api` project)         | `/health`, `/ready` via Fastify `inject` on `createServer()` from `apps/api/src/server.ts`; HTTP fallback when `API_BASE_URL` is set |
| `contract/`           | vitest (`contract` project)    | Factory output validated with TypeBox `Value.Check` against `@meetops/contracts` runtime schemas (PR #17); skips until #17 merges    |
| `integration/`        | vitest (`integration` project) | Testcontainers Postgres (pgvector) + Redis                                                                                           |
| `e2e/`                | Playwright                     | Smoke test against the web dev server (`apps/web` `dev` = vite)                                                                      |
| `factories/`          | vitest (`factories` project)   | Deterministic, seedable, organization-scoped test-data factories                                                                     |
| `support/`            | –                              | Shared helpers (e.g. Docker detection)                                                                                               |
| `vitest.workspace.ts` | –                              | One vitest project per suite                                                                                                         |

## Running

```bash
pnpm install                       # from repo root (apps/packages deps)
cd tests && pnpm install --ignore-workspace   # or: pnpm run setup
pnpm test                          # run inside tests/: all vitest suites
pnpm test:api
pnpm test:contract
pnpm test:integration
pnpm test:unit         # all unit suites (no Docker/browser)
pnpm e2e:install       # once: playwright install chromium
pnpm test:e2e          # starts apps/web dev server on WEB_PORT (5173)
E2E_CONTAINER_PORT=8080 pnpm test:e2e  # against the running web container
pnpm lint | typecheck
```

E2E is **not** part of `pnpm test`; run it explicitly (it needs browsers).

## Environment variables

| Var                                    | Default                                                                            | Used by                                                                                                                                             |
| -------------------------------------- | ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `E2E_BASE_URL`                         | unset → container port if set, else `http://localhost:$WEB_PORT` with a dev server | e2e; when set, it wins and no webServer is started                                                                                                  |
| `WEB_PORT`                             | `5173`                                                                             | e2e: vite dev server port (matches `apps/web/vite.config.ts`)                                                                                       |
| `E2E_CONTAINER_PORT`                   | unset                                                                              | e2e: when set (e.g. `8080`, the web container in `compose.app.yml`), baseURL is `http://localhost:$E2E_CONTAINER_PORT` and no dev server is started |
| `API_BASE_URL`                         | unset → in-process `inject`                                                        | api (hit a running API over HTTP)                                                                                                                   |
| `QA_SKIP_DOCKER`                       | unset                                                                              | integration; `1` forces skip                                                                                                                        |
| `QA_POSTGRES_IMAGE` / `QA_REDIS_IMAGE` | `pgvector/pgvector:pg16` / `redis:7-alpine`                                        | integration (override the images)                                                                                                                   |
| `QA_CONTRACTS_DIR`                     | unset                                                                              | contract: alias `@meetops/contracts` to another checkout's `packages/contracts` (e.g. PR #17)                                                       |
| `CI`                                   | –                                                                                  | Playwright retries, forbidOnly, html report                                                                                                         |

## Docker skip behaviour

`support/env.ts#isDockerAvailable()` runs `docker info`. If it fails (no CLI or no
daemon) the integration suites use `describe.skipIf(...)`, print a warning, and are
reported as **skipped**, never failed. CI runners with Docker run them for real.

## Factories

```ts
import { createFactories } from '../factories/index.js';
const f = createFactories({ seed: 42, organizationSlug: 'acme' });
f.organization; // { id (uuid), slug, name, createdAt, updatedAt }, deterministic for the seed
f.membership({ role: 'admin' }); // organizationId set
f.meeting({ title: 'override' });
f.fileObject(); // key under orgs/{organizationId}/
```

Same seed + organization gives identical output. Use a separate factory per
organization to build cross-organization isolation tests. Shapes follow the PR #17
domain contracts (`organizationId`). Clock is fixed (`ctx.now`).

## Mock policy

- Mocks, fakes and stubs live **only** under `tests/` (or a package's own `test/`), never in `src/`.
- Prefer real dependencies via Testcontainers over mocks for Postgres/Redis.
- External network services (AI providers, email, object storage) are mocked in CI by default.
- No paid API calls in CI. No real credentials in fixtures; use obviously fake values.

## Planned: AI provider tests (not yet implemented)

Waits on the `@meetops/ai-core` provider abstraction. Planned under `tests/ai/`:

**Deterministic mock suite (runs in CI, no network):**

- Provider contract: every adapter implements the same interface (request/response shape, errors).
- Provider switching: per-organization / per-task selection and runtime switching.
- Capability checks: unsupported features (tools, vision, JSON mode, streaming) are refused clearly before calling.
- Structured output: responses validated against contract schemas; malformed output → typed error or repair path.
- Timeouts and retries: backoff, max attempts, no retry on non-retryable errors.
- Quota exhaustion / 429: correct error surfaced; **zero paid fallback** (never silently fails over to a paid provider).
- Missing credentials: clear config error at startup/call time; no secret in logs.
- Local model fallback: falls back to the configured local model when allowed.
- Usage tracking: tokens/cost recorded per organization and per request.
- Cross-organization security: organization A can never read or use organization B's provider config or keys.

**Real-provider smoke tests (separate, opt-in):**

- Separate project/script (e.g. `test:ai:live`), excluded from `pnpm test` and CI by default.
- Enabled only by an explicit flag (e.g. `QA_AI_LIVE=1`) and only after credentials are confirmed.
- Minimal prompts, hard token caps, free/local tiers preferred.

## Dependencies on app code

- `apps/api` does not export `createServer` from its package entry (`src/index.ts` starts listening), so `api/` imports `apps/api/src/server.ts` directly. An exported builder would be cleaner.
- `contract/` needs PR #17 (`feat/core-contracts`) merged; until then it skips. It registers the `date-time`/`email` formats in its own TypeBox copy (contracts registers them in its copy). A validator exported from contracts would remove that duplication.
- Running `tests/` from root turbo needs `tests` in `pnpm-workspace.yaml` (Architecture decision).
