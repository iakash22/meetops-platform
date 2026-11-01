# Local gates and dev services

Remote GitHub Actions minutes are limited, so run gates locally before opening a PR.

## `pnpm local-gates`

`scripts/local-gates` runs, sequentially, stopping on the first failure:
`pnpm install --frozen-lockfile` → `pnpm build` → `pnpm size` (web bundle budget) → `pnpm lint` → `pnpm typecheck` → `pnpm test` → `gitleaks detect --redact`.
It prints a PASS/FAIL summary with timings. Paste the summary tail into the PR.
On shared boxes, check `pgrep -af 'pnpm|tsc|turbo'` first and run one heavy job at a time.

## Redis + MinIO without the compose plugin

```bash
scripts/dev-services.sh up      # techy-redis, techy-minio (host network, restart unless-stopped)
scripts/dev-services.sh status  # redis-cli PING + MinIO /minio/health/live
scripts/dev-services.sh down
```

Set `DOCKER="sudo docker"` if your user is not in the docker group. Credentials come from
`.env` (or the dev-only values in `.env.example`); ports from `REDIS_PORT`, `MINIO_API_PORT`,
`MINIO_CONSOLE_PORT`. The script aborts if a port is already in use. Services bind to 127.0.0.1.

## CI usage

All workflows use `concurrency` with `cancel-in-progress`. CI, QA and Docker image builds are
skipped for docs-only changes via `paths-ignore` (`docs/**`, `**/*.md`). Secret scanning always runs.

## Dev email (Mailpit)

`scripts/dev-services.sh up` also starts `techy-mailpit` (SMTP `127.0.0.1:1025`, UI http://localhost:8025).
Point the API/worker at it in `.env` (no auth):

```
EMAIL_PROVIDER=smtp
SMTP_HOST=localhost
SMTP_PORT=1025
SMTP_SECURE=false
```

Email policy: with nothing configured, the console (in-memory) sender is used; Gmail SMTP is
opt-in (app password); Resend is the production provider. See `docs/08-email/delivery.md`.
