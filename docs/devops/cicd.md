# CI/CD pipeline

> **Status: proposal.** GitHub Actions minutes are exhausted, so **the local gate is CI**
> (see [local-gates.md](../local-gates.md)). Delivery runs on the box from manual scripts. No
> Actions workflow builds, publishes or deploys, and no self-hosted runner is used.

## CI (local)

Before every PR, run `pnpm local-gates` (install, build, size, lint, typecheck, test, gitleaks).
Paste the real results into the PR. The existing workflows (`ci.yml`, `docker.yml`, `qa.yml`,
`secrets.yml`) stay as the definition of the remote checks, but they do not run while minutes
are exhausted. `ci.yml` already runs on PRs to every branch, including `integration/phase-1`.

## Build and publish images: `scripts/build-images.sh`

```bash
scripts/build-images.sh          # build + SBOM only
docker login ghcr.io             # interactive; token needs write:packages (never commit or echo it)
scripts/build-images.sh --push   # build + SBOM + push
```

- Builds `infra/docker/Dockerfile.{api,worker,web,realtime}` from a **clean** tree.
- Tags each image `ghcr.io/iakash22/meetops-platform/<app>:sha-<full commit sha>`. Images use
  immutable SHA tags only, with no moving branch tags.
- Writes an SPDX SBOM per image with [syft](https://github.com/anchore/syft) to
  `dist/images/<sha>/<app>.spdx.json` (gitignored). Keep these SBOMs with the release.
- Box notes: start dockerd with `--iptables=false`; the builds use `--network host`. Run one
  heavy job at a time.
- Overrides: `REGISTRY`, `IMAGE_REPO`.

## Deploy: `scripts/deploy.sh <staging|production> [sha]`

The script is manual only. It aborts unless all of the following pass on a clean tree:

1. `pnpm local-gates`
2. `gitleaks detect --source . --redact`
3. `node scripts/audit-gate.mjs`

`production` also requires typing a confirmation phrase. The deploy step is a **placeholder**:
no infrastructure exists yet, so the script only prints the deploy plan. Once a target exists,
it will need these values, supplied through env or a secret manager (ADR-016) and never kept
in the repo:

- `DEPLOY_TARGET`
- `DEPLOY_CREDENTIALS` (short-lived credentials preferred)
- `DATABASE_URL` (for `prisma migrate deploy`)

## Flow

commit → `pnpm local-gates` → PR (Tester & Security PASS on head SHA) → merge →
`scripts/build-images.sh --push` on the merged SHA → `scripts/deploy.sh staging <sha>` →
`scripts/deploy.sh production <sha>`.
