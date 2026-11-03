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
scripts/build-images.sh                                    # build + SBOM only
GHCR_TOKEN_FILE=~/.ghcr-token scripts/build-images.sh --push  # build + SBOM + login + push
# or pipe it: <token source> | scripts/build-images.sh --push
```

- **Login is done by Akash himself** with a fine-grained or classic token scoped to **only
  `packages:write`**. The script passes the token to `docker login ghcr.io --password-stdin`
  from stdin or `GHCR_TOKEN_FILE`. The token never appears in argv and is never echoed. The
  script logs out of GHCR on exit (`trap`). `GHCR_USER` defaults to `iakash22`.

- **Token scope:** the GHCR token **must have the `packages:write` scope** (for a classic
  token, `write:packages`). No other scope is needed.

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
3. `env -u AUDIT_GATE_NOW node scripts/audit-gate.mjs`

The script requires an interactive terminal (`[ -t 0 ]`) unless `--non-interactive` is passed
explicitly. Interactive runs (staging and production alike) need a typed `deploy <env>`
confirmation read from `/dev/tty`. `--non-interactive` skips the `/dev/tty` prompt and instead
requires `DEPLOY_CONFIRM="deploy <env>"` in the environment.
**Staging gate:** production aborts unless the same sha was deployed to staging first. The proof
is a marker file `staging-<sha>` in a fixed dir, `<passwd home>/.local/state/meetops-deploy`; it
is not configurable through env (`DEPLOY_STATE_DIR`, `XDG_STATE_HOME` and `HOME` are ignored).
The marker must be a regular file, not a symlink, owned by the current user, and the dir must be
owned by the user, not a symlink, and not group- or world-writable. The marker is written only
after a real staging deploy succeeds; the current placeholder deploys nothing and writes none.
_Threat model:_ this stops a caller's env or another local user from forging the staging proof;
it does not stop someone already running as the deploying user. Once a real target exists, the
gate should move to a successful GitHub deployment status for `environment=staging`. The `sha` must
be the full 40-hex-character commit and must equal `git rev-parse HEAD` (the default). The audit
gate runs as `env -u AUDIT_GATE_NOW node scripts/audit-gate.mjs`, so its clock cannot be
overridden. The deploy step is a **placeholder**:
no infrastructure exists yet, so the script only prints the deploy plan. Once a target exists,
it will need these values, supplied through env or a secret manager (ADR-016) and never kept
in the repo:

- `DEPLOY_TARGET`
- `DEPLOY_CREDENTIALS` (short-lived credentials preferred)
- `DATABASE_URL` (for `prisma migrate deploy`)

## Flow

commit → `pnpm local-gates` → PR (Tester & Security PASS on head SHA) → merge →
`scripts/build-images.sh --push` on the merged SHA → `scripts/deploy.sh staging <sha>` →
`scripts/deploy.sh production <sha>` (refused until staging has run for that sha).

Script tests: `bash tests/ci/deploy.test.sh` (argument, sha, TTY and staging-gate checks; no gates run).
