# CI job spec for `tests/` (QA → DevOps)

Owner of `.github/`: DevOps. QA does not edit workflows; this file is the request.
Add both jobs to `.github/workflows/ci.yml` (or a new `qa.yml`).

## Constraints the jobs must respect

- `tests/` is a pnpm workspace member (`@meetops/tests`), so the single root
  `pnpm install --frozen-lockfile` installs it. No second install step.
- pnpm version comes from the root `packageManager` field (pnpm@9.12.3) via `pnpm/action-setup@v4`.
- Node 20, same as the existing `build` job.
- Root `pnpm lint/typecheck/test` (turbo, existing `build` job) already run `tests/` lint, typecheck
  and vitest suites. Without Docker the integration suites skip there; `qa-integration` makes
  sure they run for real, and `qa-e2e` runs Playwright (not part of `pnpm test`).

## Job 1: `integration` (Testcontainers on ubuntu-latest)

GitHub-hosted `ubuntu-latest` runners ship a Docker daemon, so Testcontainers works with no
service containers. Each suite starts its own `pgvector/pgvector:pg16` and `redis:7-alpine`
container and the schema comes from `packages/database/prisma/migrations` (PR #6).

Env vars:

| Var                            | Value                    | Why                                                                |
| ------------------------------ | ------------------------ | ------------------------------------------------------------------ |
| `QA_POSTGRES_IMAGE`            | `pgvector/pgvector:pg16` | Default already; pinned explicitly for clarity                     |
| `QA_REDIS_IMAGE`               | `redis:7-alpine`         | Default                                                            |
| `TESTCONTAINERS_RYUK_DISABLED` | `false`                  | Keep Ryuk on so containers are reaped                              |
| `QA_DB_PACKAGE_DIR`            | unset                    | Defaults to `packages/database`; set only to test another checkout |

The seed step (`prisma/seed.ts`) needs the generated Prisma client in `packages/database`, which
the root `pnpm install` produces via its `postinstall` (`prisma generate`) once PR #6 is merged.

```yaml
qa-integration:
  runs-on: ubuntu-latest
  timeout-minutes: 20
  env:
    QA_POSTGRES_IMAGE: pgvector/pgvector:pg16
    QA_REDIS_IMAGE: redis:7-alpine
  steps:
    - name: Checkout
      uses: actions/checkout@v4

    - name: Setup pnpm
      uses: pnpm/action-setup@v4

    - name: Setup Node.js
      uses: actions/setup-node@v4
      with:
        node-version: 20
        cache: 'pnpm'

    - name: Install dependencies (root workspace, includes tests/)
      run: pnpm install --frozen-lockfile

    - name: Pre-pull container images
      run: |
        docker pull "$QA_POSTGRES_IMAGE"
        docker pull "$QA_REDIS_IMAGE"

    - name: Lint and typecheck tests/
      working-directory: tests
      run: |
        pnpm lint
        pnpm typecheck

    - name: Unit, contract, security and API suites
      working-directory: tests
      run: pnpm test:unit

    - name: Integration suites (Testcontainers)
      working-directory: tests
      run: pnpm test:integration
```

### Alternative: service containers instead of Testcontainers

Only if Docker-in-job is unavailable (e.g. a self-hosted runner without a daemon). The current
suites start their own containers, so this variant needs a small test change (connect via
`DATABASE_URL`/`REDIS_URL` instead of starting a container), which QA will add if DevOps picks it.

```yaml
qa-integration-services:
  runs-on: ubuntu-latest
  services:
    postgres:
      image: pgvector/pgvector:pg16
      env:
        POSTGRES_USER: meetops
        POSTGRES_PASSWORD: meetops
        POSTGRES_DB: meetops_test
      ports: ['5432:5432']
      options: >-
        --health-cmd "pg_isready -U meetops"
        --health-interval 5s --health-timeout 5s --health-retries 10
    redis:
      image: redis:7-alpine
      ports: ['6379:6379']
      options: >-
        --health-cmd "redis-cli ping"
        --health-interval 5s --health-timeout 5s --health-retries 10
  env:
    DATABASE_URL: postgresql://meetops:meetops@localhost:5432/meetops_test
    REDIS_URL: redis://localhost:6379
  steps:
    # same checkout / pnpm / node / install steps as qa-integration, then:
    - name: Integration suites (service containers)
      working-directory: tests
      run: pnpm test:integration
```

## Job 2: `e2e` (Playwright, chromium)

Playwright's `webServer` starts the web dev server itself (`pnpm --filter @meetops/web dev
--port $WEB_PORT --strictPort`), so no separate start step is needed. Browsers are cached by
Playwright version.

Env vars:

| Var                  | Value                   | Why                                                                                            |
| -------------------- | ----------------------- | ---------------------------------------------------------------------------------------------- |
| `CI`                 | `true` (set by Actions) | retries=2, `forbidOnly`, html report                                                           |
| `WEB_PORT`           | `5173`                  | vite dev server port (matches `apps/web/vite.config.ts`)                                       |
| `E2E_CONTAINER_PORT` | unset                   | Set to `8080` only for a variant that targets the web container from `compose.app.yml` (PR #7) |
| `E2E_BASE_URL`       | unset                   | Set only to test a deployed environment                                                        |

```yaml
qa-e2e:
  runs-on: ubuntu-latest
  timeout-minutes: 20
  env:
    WEB_PORT: 5173
  steps:
    - name: Checkout
      uses: actions/checkout@v4

    - name: Setup pnpm
      uses: pnpm/action-setup@v4

    - name: Setup Node.js
      uses: actions/setup-node@v4
      with:
        node-version: 20
        cache: 'pnpm'

    - name: Install dependencies (root workspace, includes tests/)
      run: pnpm install --frozen-lockfile

    - name: Get Playwright version
      id: pw
      working-directory: tests
      run: echo "version=$(pnpm exec playwright --version | awk '{print $2}')" >> "$GITHUB_OUTPUT"

    - name: Cache Playwright browsers
      id: pw-cache
      uses: actions/cache@v4
      with:
        path: ~/.cache/ms-playwright
        key: playwright-${{ runner.os }}-${{ steps.pw.outputs.version }}

    - name: Install Playwright chromium (with OS deps)
      if: steps.pw-cache.outputs.cache-hit != 'true'
      working-directory: tests
      run: pnpm exec playwright install --with-deps chromium

    - name: Install Playwright OS deps only (cache hit)
      if: steps.pw-cache.outputs.cache-hit == 'true'
      working-directory: tests
      run: pnpm exec playwright install-deps chromium

    - name: Run E2E (starts apps/web dev server)
      working-directory: tests
      run: pnpm test:e2e

    - name: Upload Playwright report
      if: ${{ !cancelled() }}
      uses: actions/upload-artifact@v4
      with:
        name: playwright-report
        path: |
          tests/playwright-report/
          tests/test-results/
        retention-days: 14
```

## Expected results today (measured on the QA box, 2026-10-21)

- `pnpm test` in `tests/` with Docker and PR #6's database package (`QA_DB_PACKAGE_DIR`):
  9 files (7 passed, 2 skipped), 146 tests: 24 passed, 122 skipped, 0 failed.
- Same on current main (no migrations yet): DB suite skips; 16 passed, 126 skipped.
- `pnpm test:e2e`: 1 passed.
- Skips are intentional placeholders (XT/AU/SS security cases waiting on API auth and a URL
  validator, RLS waiting on `feat/database-tenancy-rls`, contract waiting on PR #17).

## Open questions for DevOps

1. Required check or informational at first? QA suggests required for `qa-integration`,
   informational for `qa-e2e` until the web app has real pages.
