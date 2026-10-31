# MeetOps — handoff for a new agent

Written 31 Oct 2026 (IST). Read this first; it assumes no prior context. Owner: **Akash** (GitHub `iakash22`).

## 1. Repo and branches

- Repo: `iakash22/meetops-platform` (pnpm + turbo monorepo: `apps/api`, `apps/web`, `apps/worker`, `apps/extension` (wxt), desktop (Tauri/Rust), mobile (Expo/React Native), `packages/*` incl. `contracts`, `integrations`, `notifications`, `storage`).
- Work branch: **`integration/phase-1`** (at `a868a4c` before this handoff PR). All feature PRs target it.
- `main`: only Akash merges into `main` (latest: #257, 31 Oct).
- Other docs: [PHASE_STATUS.md](PHASE_STATUS.md), [PROJECT_CONTEXT.md](PROJECT_CONTEXT.md), [AGENT_STATUS.md](AGENT_STATUS.md), [local-gates.md](local-gates.md), ADRs in [15-decisions/](15-decisions/).

## 2. Project state (estimates, see PHASE_STATUS.md)

P0 100% · P1 ~95% · P2 ~85% · P3 ~70% · P4 ~75% · P5 ~80% · P6 ~85% · P7 ~45% · P8 ~75% · P9 ~35% · **overall ~72%**.

Merged 31 Oct (#305–#317): extension real meeting API + held recordings (#305, #307, #308); auth mail queue (#306); GitHub App E2E (#309, #313); mobile M3–M6 (#310–#312); P7 calendar, search, web, follow-ups (#314–#317). The handoff PR also fixes #317 L-1 / Info 2 / Info 3 (calendar refresh scope handling, re-encrypt guards).

## 3. Team rules (non-negotiable)

- No Cursor and no Slack for project work.
- GitHub Actions minutes are exhausted: **all gates run locally** — build, lint, typecheck, test, gitleaks — and the results are pasted into every PR.
- A merge needs a **Tester & Security PASS on the exact head SHA**. Merge with `gh pr merge --match-head-commit <sha>`.
- No force-push, no rebase, no `--no-verify`; git hooks stay on. Regular commits only.
- Never print or commit secrets (use placeholders in tests; `gitleaks detect --redact` must be clean).
- Only Akash merges into `main`.
- Email: Mailpit in dev, Gmail SMTP opt-in, Resend in production. **Never fall back from one provider to another.**
- No covert recording: capture is always visible and consented.

## 4. Box environment notes

- `export COREPACK_HOME=/tmp/corepack` before pnpm.
- inotify is exhausted by a host process (ENOSPC). The wxt watcher fix is in #313. Warm the cache with `pnpm lint --concurrency=1`.
- Docker is the static 27.3.1 build in `/usr/local/bin`. Start `dockerd --iptables=false --ip6tables=false` and run containers with `--network host`.
- DNS is fake-IP and the apt mirror is unreachable: do not rely on `apt install`.
- Shared box: check `pgrep -af 'pnpm|tsc|turbo'` and run one heavy job at a time. Prefer scoped gates (`pnpm --filter <pkg> ...`) when usage is tight.

## 5. Blocked on Akash

1. Google OAuth client (calendar + login).
2. Install the `meetops-dev` GitHub App on a throwaway repo for E2E.
3. Gemini API key for P3.
4. Real bundle ids (replace `ai.meetops.desktop.todo-owner`, `com.example.meetops`).
5. Expo / React Native upgrade decision.
6. Dependabot read permission on the token.
7. ADR sign-offs: 006, 010, 011, 012, 013.
8. Windows `pnpm test` and `cargo check`.
9. Jira credentials.

## 6. Next tasks (priority order)

1. **Native mobile** (blocks store submission): Android foreground service, iOS Live Activity, Android Keystore encryption, iOS backup exclusion.
2. **P7**: calendar background sync job, Outlook adapter, linking calendar events to meetings, pgvector semantic search.
3. **#313 follow-ups**: prettier on `github-app.e2e.test.ts`, segment-only E2E name matching, env PEM opt-in, check the selected repos.
4. **Extension Info items**: Start fails open; unheld pending eviction; 8 MB vs 64 MB chunk size mismatch.
5. **Desktop**: migrate old chunk folders; `chunk_put` sends JSON arrays (switch to binary).
6. **Mobile Lows**: consent meeting id should come from the server; a failed delete is ignored on wipe.

## 7. How to resume (checklist)

- [ ] `git fetch origin && git switch -c <topic> origin/integration/phase-1`; read PHASE_STATUS.md and this file.
- [ ] `gh pr list --state open` — check open PRs and review state.
- [ ] Set `COREPACK_HOME=/tmp/corepack`; `pnpm install --frozen-lockfile`.
- [ ] Warm cache: `pnpm lint --concurrency=1`.
- [ ] If DB/Redis/MinIO/Mailpit needed: start dockerd (flags above), then `scripts/dev-services.sh up`.
- [ ] Pick the top unblocked task from §6; commit normally with hooks on.
- [ ] Run gates locally (`pnpm local-gates`, or scoped build/lint/typecheck/test + `gitleaks detect --redact`); paste results in the PR.
- [ ] Open the PR against `integration/phase-1`; get Tester & Security PASS on the exact head; merge with `--match-head-commit`.
- [ ] Update PHASE_STATUS.md when phases move.
