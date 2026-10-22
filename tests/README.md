# MeetOps AI — QA harness (`tests/`)

Cross-cutting test suites live here as the `@meetops/tests` workspace package.

It is a pnpm workspace member (`'tests'` in `pnpm-workspace.yaml`) and uses the root
TypeScript/vitest versions and the root lockfile. Root `pnpm typecheck`, `pnpm lint` and
`pnpm test` (turbo) include it. `apps/api` source is imported by relative path.

## Layout

| Path                                     | Runner                         | What                                                                                                                                                                             |
| ---------------------------------------- | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `api/`                                   | vitest (`api` project)         | `/health`, `/ready` via Fastify `inject` on `createServer()` from `apps/api/src/server.ts`; HTTP fallback when `API_BASE_URL` is set                                             |
| `contract/`                              | vitest (`contract` project)    | Factory output validated with TypeBox `Value.Check` against `@meetops/contracts` runtime schemas (PR #17)                                                                        |
| `integration/`                           | vitest (`integration` project) | Testcontainers Postgres (pgvector) + Redis; `database.test.ts` applies PR #6 migrations, runs `seed.ts`, checks organization isolation and pgvector similarity; RLS placeholders |
| `e2e/`                                   | Playwright                     | Smoke test against the web dev server (`apps/web` `dev` = vite)                                                                                                                  |
| `factories/`                             | vitest (`factories` project)   | Deterministic, seedable, organization-scoped test-data factories                                                                                                                 |
| `security/`                              | vitest (`security` project)    | Security case catalogue from `docs/12-security/test-cases.md` (PR #4): XT (cross-organization), AU (auth abuse), SS (SSRF) as ID-tagged `describe.skip` placeholders             |
| `fixtures/security/ssrf.ts`              | –                              | Exported SSRF payloads SS-01..SS-32 (`ssrfPayloads`, `ssrfUrlPayloads`, `ssrfScenarios`, `withAllowedHost`) for URL validators to import                                         |
| `ci/ci-jobs-spec.md`                     | –                              | CI job request for DevOps (integration + e2e YAML)                                                                                                                               |
| `support/`                               | –                              | Shared helpers (e.g. Docker detection)                                                                                                                                           |
| `vitest.config.ts`, `vitest.projects.ts` | –                              | One vitest project per suite (`test.projects` on vitest ≥ 3.2, workspace file on 2.x)                                                                                            |

## Running

```bash
pnpm install                       # from repo root (apps/packages deps)
pnpm test                          # root: turbo runs every package incl. @meetops/tests
pnpm --filter @meetops/tests test  # just tests/ (or `pnpm test` inside tests/)
pnpm test:api
pnpm test:contract
pnpm test:integration
pnpm test:security
pnpm test:unit         # all unit suites (no Docker/browser)
pnpm e2e:install       # once: playwright install chromium
pnpm test:e2e          # starts apps/web dev server on WEB_PORT (5173)
E2E_CONTAINER_PORT=8080 pnpm test:e2e  # against the running web container
pnpm lint | typecheck
```

E2E is **not** part of `pnpm test`; run it explicitly (it needs browsers).

## Environment variables

| Var                                    | Default                                                                            | Used by                                                                                                                                                                                                                     |
| -------------------------------------- | ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `E2E_BASE_URL`                         | unset → container port if set, else `http://localhost:$WEB_PORT` with a dev server | e2e; when set, it wins and no webServer is started                                                                                                                                                                          |
| `WEB_PORT`                             | `5173`                                                                             | e2e: vite dev server port (matches `apps/web/vite.config.ts`)                                                                                                                                                               |
| `E2E_CONTAINER_PORT`                   | unset                                                                              | e2e: when set (e.g. `8080`, the web container in `compose.app.yml`), baseURL is `http://localhost:$E2E_CONTAINER_PORT` and no dev server is started                                                                         |
| `API_BASE_URL`                         | unset → in-process `inject`                                                        | api (hit a running API over HTTP)                                                                                                                                                                                           |
| `QA_SKIP_DOCKER`                       | unset                                                                              | integration; `1` forces skip                                                                                                                                                                                                |
| `QA_POSTGRES_IMAGE` / `QA_REDIS_IMAGE` | `pgvector/pgvector:pg16` / `redis:7-alpine`                                        | integration (override the images)                                                                                                                                                                                           |
| `QA_DB_PACKAGE_DIR`                    | `../packages/database`                                                             | integration/db: where Prisma migrations + `seed.ts` live (e.g. a worktree of PR #6). Suite skips if no migrations; seed test skips if that package has no installed `tsx`/`@prisma/client`                                  |
| `QA_API_DIR`                           | `../apps/api` (this repo)                                                          | api/auth: `apps/api` with the auth/orgs modules (merged from PR #27). Defaults to the repo's own API so the AU/XT API suites run in CI; set it to test another checkout. They skip only when the target has no auth module. |
| `QA_RLS_SCHEMA`                        | `migrations`                                                                       | integration/rls: `migrations` = `prisma migrate deploy` (production path); `datamodel` = build tables from `schema.prisma` and apply only the RLS migration (workaround while DB-BUG-1 is open)                             |
| `QA_CONTRACTS_DIR`                     | `../packages/contracts`                                                            | contract: alias `@meetops/contracts` to another checkout's `packages/contracts` (e.g. PR #17)                                                                                                                               |
| `CI`                                   | –                                                                                  | Playwright retries, forbidOnly, html report                                                                                                                                                                                 |

## Docker skip behaviour

`support/env.ts#isDockerAvailable()` runs `docker info`. If it fails (no CLI or no
daemon) the integration suites use `describe.skipIf(...)`, print a warning, and are
reported as **skipped**, never failed. CI runners with Docker run them for real.

## Security suites

- IDs match `docs/12-security/test-cases.md` exactly; a catalogue test asserts XT-01..30 and AU-01..35 are all present.
- XT and AU are skipped until API auth and organization context exist.
- XT-26..29 (RLS) are real tests in `integration/rls.test.ts`, run against PR #25 (`feat/database-tenancy-rls`) through `QA_DB_PACKAGE_DIR`. They use a LOGIN role that inherits `meetops_app`.
- SSRF: import from `fixtures/security/ssrf.ts`, e.g. `it.each(ssrfUrlPayloads)('$id rejects $url', ...)`. `ALLOWED_HOST` is a placeholder; swap it with `withAllowedHost(url, host)`.
- Query-level analogues of XT-01/13/14 already run in `integration/database.test.ts`.

## P1-QA-3: XT and AU suites

- `api/auth/auth-abuse.test.ts`: AU-01..05, 07..19, 21..28 against PR #27 `createServer` (in-memory repos, injected fake clock and hasher, recording mailer). Signup is checked to be enumeration-safe (202, never `CONFLICT`).
- `api/auth/cross-org.test.ts`: XT-01/04 analogues on `/orgs`, XT-21 (invitations), XT-30 (org switch, `X-Org-Id`). They expect 404 `NOT_FOUND` with the same body as a missing id.
- `integration/xt-db.test.ts`: XT-01..04, 10, 13, 14 through `withOrgContext` (PR #25) with a Prisma client logged in as a `meetops_app` member.
- `security/*.test.ts` list every XT/AU ID as implemented (with location) or pending (with reason); a test enforces that.

Full local run:

```bash
QA_API_DIR=/path/to/pr27/apps/api \
QA_DB_PACKAGE_DIR=/path/to/pr25/packages/database QA_RLS_SCHEMA=datamodel \
pnpm --filter @meetops/tests test
```

## Known product bugs (tests left failing or `it.fails`)

| ID       | Owner                        | Found by                                                                                                               | Summary                                                                                                                                                                                                                                                                                                                                                                                                            |
| -------- | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| DB-BUG-1 | DB (PR #25; fixed in PR #35) | `integration/database.test.ts` "applies every migration", `integration/rls.test.ts` setup (`QA_RLS_SCHEMA=migrations`) | `20261021100000_tenancy_hardening` does not apply to a fresh DB: it `ALTER`s `"tasks"` before creating it (`relation "tasks" does not exist`). Without that line it then fails dropping `TaskPriority_old` (still used by `internal_tasks`). The migration doesn't match the init migration. `prisma migrate deploy` fails, so the seed fails too.                                                                 |
| DB-BUG-2 | DB (PR #25)                  | `integration/rls.test.ts` XT-28 (strict; fixed in PR #35, fails against PR #25)                                        | After a transaction-local `set_config('app.current_org_id', …, true)`, the session keeps `''`; policies do `current_setting(…, true)::uuid`, so the next query without context on a pooled connection errors with 22P02 instead of returning 0 rows. Fails closed (no leak), but breaks pooled connections. Fix: `NULLIF(current_setting('app.current_org_id', true), '')::uuid` (same for `app.current_user_id`). |

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
- `contract/` validates against the `@meetops/contracts` schemas from PR #17, which is merged into `integration/phase-1`. Contracts' `Id` is still `minLength: 1` ("cuid/uuid"); the factories emit v4 UUIDs everywhere and a test checks it.
