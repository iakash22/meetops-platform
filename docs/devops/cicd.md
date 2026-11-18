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
overridden.

**Target interface** (`scripts/deploy-lib.sh`, target-agnostic; no real target is wired in):

| Env (passed through the `env -i` allowlist) | Rule                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DEPLOY_TARGET`                             | unset/`none` = gates only, deploys nothing, writes no marker. Any other value must be in `DEPLOY_KNOWN_TARGETS` (only `none` today) **and** have a `deploy_target_<name>` function, else the run is refused before any gate.                                                                                                                                                                         |
| `DEPLOY_CREDENTIALS_FILE`                   | required for a real target: absolute path to a regular, non-symlink file owned by you, mode `0600`/`0400`. Name/path are checked before gates; the file is opened onto fd 7 only after gates and confirmation (fstat via `/proc/self/fd`, dev:inode must match the path, parent dir not group/world-writable); the target gets `/dev/fd/7`, never the path. Gates and prisma do not inherit this fd. |
| `DEPLOY_DATABASE_URL_FILE`                  | required for a real target, same file rules, must hold a `postgres://` URL. Opened onto fd 8 only after gates and confirmation, read once, then closed immediately. Only `prisma migrate deploy` sees the URL, as `DATABASE_URL` (env, not argv). Gates, prisma, and the target do not inherit fd 8.                                                                                                 |
| `DEPLOY_CREDENTIALS`                        | refused if set (secrets as files, not env values).                                                                                                                                                                                                                                                                                                                                                   |

Order for a real target: gates → confirmation → open secret files → `prisma migrate deploy` (credential fd closed in the child) → `deploy_target_<name> <env> <sha>
<credentials-file>` → (staging only) staging marker. A failed migration stops before rollout; a failed rollout
writes no marker, so production can never be unlocked by a placeholder or failed run. Adding a real target is one
reviewed PR that appends to `DEPLOY_KNOWN_TARGETS` and defines its function (needs-owner: hosting choice, ADR-016
secret manager).

## Deploy env: realtime `TRUST_PROXY` (after #455)

Realtime and the API share `TRUST_PROXY` / `BEHIND_CLOUDFLARE` in **code** (`packages/config/src/client-ip.ts`).
Before rolling a production image that includes #455:

1. Set `TRUST_PROXY` to a comma list of proxy IPs/CIDRs that **includes the nginx address**
   realtime sees (or its network CIDR). Unset becomes hop count `1` in compose for realtime,
   which **fails startup when `NODE_ENV=production`**.
2. Remove any `REALTIME_TRUST_PROXY_HOPS` from the deploy environment (non-zero values now fail
   realtime startup; use `TRUST_PROXY` instead).
3. Remember one compose/`TRUST_PROXY` value feeds **both** API and realtime: trusting a whole
   docker network range makes the API honour X-Forwarded-For from that range too.
4. **`BEHIND_CLOUDFLARE`:** `infra/compose/compose.app.yml` passes
   `BEHIND_CLOUDFLARE` to both the API (`x-api-env`) and the realtime service.
   Default empty/off. For a Cloudflare edge in front of the stack, set it to `true`
   so both processes honour `CF-Connecting-IP`. Non-compose deploys must export it
   for both processes too. If the API is behind Cloudflare without
   `BEHIND_CLOUDFLARE`, the resolved client IP is the Cloudflare edge
   (peer after `TRUST_PROXY`), so per-IP rate limits share one bucket per edge and one busy edge
   (or attacker) can 429 / lock out many users. Setting the flag is still fail-closed for spoofed
   headers: `CF-Connecting-IP` is ignored unless that peer is in the pinned Cloudflare ranges.
   Locking the origin firewall to those ranges remains recommended defence-in-depth.
5. **IPv4-mapped IPv6:** `normalizeIp` treats `::ffff:a.b.c.d` as `a.b.c.d`. IPv4
   `TRUST_PROXY` entries match mapped peers; rate-limit keys and Cloudflare edge checks use the
   normalised form so one client does not split across two keys. Details in
   [environment-variables.md](../00-getting-started/environment-variables.md).

Details: [environment-variables.md](../00-getting-started/environment-variables.md) (API + Realtime).

## Flow

commit → `pnpm local-gates` → PR (Tester & Security PASS on head SHA) → merge →
`scripts/build-images.sh --push` on the merged SHA → `scripts/deploy.sh staging <sha>` →
`scripts/deploy.sh production <sha>` (refused until staging has run for that sha).

Script tests: `bash tests/ci/release.test.sh` (SBOM + versioning). `bash tests/ci/deploy.test.sh` (argument, sha, TTY and staging-gate checks; no gates run) and
`bash tests/ci/deploy-lib.test.sh` (target interface, migrate → rollout → marker order, secret-fd inheritance, stub target only).
