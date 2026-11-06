# 13 — Operations

How MeetOps is built, deployed and run. Hosting is not chosen yet (needs-owner), so everything here is
target-agnostic and runs locally first.

| Topic                        | Where                                                                                               |
| ---------------------------- | --------------------------------------------------------------------------------------------------- |
| Containers, images, CI jobs  | [containers-and-ci.md](containers-and-ci.md), `infra/docker/`, `scripts/build-images.sh`            |
| Local stack                  | `infra/compose/` ([README](../../infra/compose/README.md)), `pnpm dev:stack`                        |
| Local gates (the CI)         | [../local-gates.md](../local-gates.md), `pnpm local-gates`, `scripts/audit-gate.mjs`                |
| Deploy scripts               | `scripts/deploy.sh` → `scripts/deploy-impl.sh` (#408, #427), [../devops/cicd.md](../devops/cicd.md) |
| Release checklist            | [../p9/release-checklist.md](../p9/release-checklist.md)                                            |
| Monitoring and alerts        | [../14-observability/README.md](../14-observability/README.md)                                      |
| Backups and restore          | [../16-runbooks/backup-restore.md](../16-runbooks/backup-restore.md)                                |
| Runbooks                     | [../16-runbooks/](../16-runbooks/README.md)                                                         |
| Object storage in production | [../../infra/docs/object-storage-prod.md](../../infra/docs/object-storage-prod.md)                  |

## Rules

- Remote GitHub Actions are not usable (minutes exhausted): `pnpm local-gates` + `gitleaks` on the exact SHA is the
  gate; paste results into the PR.
- Secrets come from the secrets dir / secret manager (ADR-016, needs-owner), never from images or the repo.
- Migrations: `prisma migrate deploy` once per release, before the new API starts; forward-only and compatible with
  the previous app version.
- Providers never fall back silently: one STT provider per org, no paid-AI fallback, no email-provider fallback.

## Open (needs-owner)

Hosting target, secret manager, alert destination, production domain/TLS, backup storage. See
`docs/p9/remaining-work.md`.
