# Risk-exception expiry tracker (TS-5)

Written 1 Nov 2026 (IST) from `integration/phase-1` @ `e4aceac4`. It adds to
[risk-exceptions.md](risk-exceptions.md) and does not replace it. No secrets in this file.

> **Update 1 Nov 2026 (IST): RE-01 and RE-03 are closed.**
>
> - RE-01: GHSA-vfj7-8cjw-p6xm was withdrawn on 2026-10-23.
> - RE-03: the lockfile already resolves `node-forge@1.4.2`, which is outside the affected range `<=1.4.0`, through the root override `"node-forge@<1.4.2": "1.4.2"` (#297). The `node-forge@1.4.0` (stale; resolves 1.4.2 now, CLOSED) reading below was **out of date**. It came from a stale lockfile read.
> - Both gate rows are removed. See "Closed entries" in [risk-exceptions.md](risk-exceptions.md).
> - The RE-01 owner mismatch (register said Frontend, gate said DevOps Agent) is now moot. Keep owners aligned for future entries.
> - **Only RE-04 remains**, and the rows below for RE-01 and RE-03 are kept for history only.
>
> **Re-check 11 Nov 2026 (IST), `integration/phase-1` @ `6feef782` (issue #54):** `scripts/audit-gate.mjs` has no RE-01
> row, `pnpm audit` reports no `braces` advisory, and the gate passes with `AUDIT_GATE_NOW=2026-11-21T00:00:01Z`
> (after the old RE-01 expiry). The lockfile resolves only `braces@3.0.3` (still the latest release). GitHub lists
> GHSA-vfj7-8cjw-p6xm as withdrawn (2026-10-23T12:53:02Z); GHSA-grv7-fg5c-xmjg (`<3.0.3`) and GHSA-cwfw-4gq5-mrqx
> (`>=2.2.0 <2.3.1`) don't match 3.0.3. No override or lockfile change is needed. Issue #54 can be closed.

## Dependency paths (from `pnpm-lock.yaml`; `node_modules` were not installed, so `pnpm why` was not run)

| ID    | Vulnerable package                                     | Paths in the lockfile                                                                                                                                                                                                           | Runtime exposure       |
| ----- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| RE-01 | `braces@3.0.3`                                         | `apps/web` → `tailwindcss@3.4.19` → `chokidar@3.6.0` / `fast-glob` / `micromatch@4.0.8` → braces; root `lint-staged@15.5.2` → `micromatch@4.0.8` → braces                                                                       | Dev/build only         |
| RE-03 | `node-forge@1.4.0` (stale; resolves 1.4.2 now, CLOSED) | `apps/extension` → `wxt@0.20.27` → `web-ext-run` → `@devicefarmer/adbkit` → node-forge; `apps/mobile` → `expo@52.0.49` → `@expo/cli` (direct, `@expo/code-signing-certificates`, `@react-native/dev-middleware` → `selfsigned`) | Dev tooling (Expo CLI) |
| RE-04 | `image-size@1.2.1`                                     | `apps/mobile` → `expo@52.0.49` / `react-native@0.76.9` → `@react-native/community-cli-plugin` → `metro@0.81.5` → image-size (also through `jest-expo`)                                                                          | Bundler only           |

Re-check these with `pnpm why -r <pkg>` and `pnpm audit --json` on the remediation branch before you close an entry.

## Owner and remediation

| ID    | Gate expiry (UTC)    | Remediation                                                                                                 | Owner                                                          |
| ----- | -------------------- | ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| RE-01 | 2026-11-20T23:59:59Z | Tailwind 4 migration in `apps/web`; also move lint-staged off micromatch 4 (or wait for a patched braces)   | Frontend. The gate row says "DevOps Agent". **Align the two.** |
| RE-03 | 2026-11-24T23:59:59Z | `wxt` 0.21 spike (removes the adbkit path) **and** the Expo SDK / RN upgrade (removes the `@expo/cli` path) | DevOps Agent (wxt), Mobile (Expo)                              |
| RE-04 | 2026-11-24T23:59:59Z | Expo SDK / RN upgrade (newer metro drops image-size 1.x). An override is unsafe (see the register)          | Mobile / DevOps Agent                                          |

## Dated tracker (dates in IST)

| ID                         | Spike / branch started | Remediation PR open | Maddy decision: renew or remove | Gate expiry                         |
| -------------------------- | ---------------------- | ------------------- | ------------------------------- | ----------------------------------- |
| RE-01                      | by 6 Nov               | **by 13 Nov**       | **by 18 Nov**                   | 21 Nov 05:29 IST (20 Nov 23:59:59Z) |
| RE-04 (RE-03 closed 1 Nov) | by 10 Nov              | **by 17 Nov**       | **by 22 Nov**                   | 25 Nov 05:29 IST (24 Nov 23:59:59Z) |

If the remediation PR isn't merged by the decision date, Maddy either renews the entry (with a new review date, a
written reason, and a matching change to `expires` in `scripts/audit-gate.mjs`, both in one PR) or accepts that CI
goes red at expiry. An exception is never renewed silently.

Note: the Expo/RN upgrade is also the decision HANDOFF §6 still lists as open with Maddy, so RE-03/RE-04
depend on it. Plan a renewal if that decision is still open on 17 Nov.

## Gate behaviour (checked in `scripts/audit-gate.mjs`)

- **It already fails on expired exceptions.** When a high/critical advisory matches a row and `now > expires`, it
  logs `exception RE-xx expired …` and exits 1. The expiry is applied per advisory. `AUDIT_GATE_NOW` is ignored in CI.
- Gaps (proposed, not implemented):
  1. **Stale rows are silent.** A row that has expired but no longer matches any advisory (because it was fixed)
     isn't reported, so dead rows build up. Proposal: print a warning for each row with no matching advisory, and
     fail on a row that has expired whether or not it still matches.
  2. **No early warning.** Proposal: print a `::warning::` when a row expires within 7 days.
  3. **The register and the gate can drift** (for example, the RE-01 owner). Proposal: a small check that parses the
     IDs and review dates in `risk-exceptions.md` and compares them with `EXCEPTIONS`.
  4. **No unit tests.** The script runs `pnpm audit` at the top level. To test it, move the decision logic into an
     exported pure function `evaluate(advisories, exceptions, now)` and test it with fixtures (node:test, no new
     dependency).
     I left the code unchanged: the existing expiry logic is correct, and the refactor above is needed before any
     change can be covered by a test.
