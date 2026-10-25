# Dev compose stack (LOCAL DEV ONLY)

`compose.dev.yml` (postgres, redis, minio, minio-init, optional ollama / local-stt)
plus `compose.app.yml` (migrate, api, worker, web, optional realtime). Start with
`scripts/compose-up.sh` after `scripts/gen-dev-secrets.sh`.

## Migrations fail loudly (until PR #35)

`migrate` runs `db:migrate:deploy` then `db:seed` (dev only) from
`packages/database` as `meetops_migrator`. `infra/compose/bin/with-secrets.sh`
(`DB_ROLE=migrator`) sets both `MIGRATION_DATABASE_URL` and `DATABASE_URL` to the
migrator role, because prisma reads both and the seed uses `DATABASE_URL`.

`pnpm --filter … run <script>` exits 0 when a script is missing, so `migrate`
checks for both scripts first. While they are missing it exits 1 with:

    packages/database db:migrate:deploy missing; requires PR #35

`api` and `worker` keep `depends_on: migrate: service_completed_successfully`,
so **the stack visibly fails to start until PR #35 merges**. That is intended:
apps never run against an unmigrated schema.

## Secrets

See `secrets/README.md`. App services do not load `.env`; they get explicit
non-secret `environment:` lists and read every credential from `/run/secrets`.
