# scripts/

DevOps-owned helper scripts. See each file's header for details.

## local-gates: run CI's gates locally

GitHub Actions minutes on this private free-plan repo can run out, which turns every
run red before a single step executes. When that happens (or any time), run the
same gates on this machine and paste the summary into your PR:

```sh
export COREPACK_HOME=$HOME/.corepack   # pnpm 9.12.3 via corepack, never `corepack enable`
scripts/local-gates                    # current working tree
scripts/local-gates origin/feat/foo    # any branch/ref, in a temp worktree (your checkout is untouched)
```

It runs, in order: `pnpm install --frozen-lockfile`, `turbo run build|lint|typecheck|test
--concurrency=1`, and `gitleaks detect` with the same flags as `secrets.yml`. Each
step keeps going after a failure and records pass/fail/skip plus its duration. Everything
runs under `nice`/`ionice`. If gitleaks is missing, the script downloads pinned
v8.21.2 into `~/.local/bin` and checks its checksum. If it can't download, or you set
`LOCAL_GATES_NO_DOWNLOAD=1`, it skips gitleaks and says so in the summary.

At the end it prints a Markdown summary: commit SHA, Node and pnpm versions, a results
table, and a "run locally, CI minutes exhausted" note. The summary is also saved as
`summary.md` in the log directory, along with one log per step. The script exits 1 if any step failed.

Notes: turbo cache hits count as passes, since turbo replays the cached result for the same inputs.
Without a ref, uncommitted changes are included and the summary flags them. The CI-only
checks (Docker image builds, live-db, QA e2e, audit gate) are not covered.
