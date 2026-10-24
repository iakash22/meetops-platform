# Plan: migrate to Zod 4

Status: proposal. Owner: DevOps (packages/config), with Notifications and Web owners for their packages.
Baseline: `integration/phase-1` @ `01b1dab` (after #21, which added zod 4 to `packages/ai-core`).

## 1. Inventory

| Workspace                | Declared range | Resolved (lockfile) | Zod usage                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------ | -------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/config`        | `^3.23.8`      | `3.25.76`           | `envSchema` (`z.object`, `z.enum`, `z.coerce.number`, `.url()`, `.default()`, `.refine`/`.transform`), `safeParse`, `error.message`                                                                                                                                                                                                                          |
| `packages/notifications` | `^3.23.8`      | `3.25.76`           | SMTP/console env schemas, `.refine({ message })`, `.default()`, `.optional()`, `z.ZodError` + `err.issues` formatting                                                                                                                                                                                                                                        |
| `apps/web`               | `^3.23.8`      | `3.25.76`           | Auth/org form schemas (`.min(n, 'msg')`, `.email('msg')`, `.refine({ path, message })`) via `@hookform/resolvers@3.10.0` `zodResolver`                                                                                                                                                                                                                       |
| `packages/ai-core`       | `^4`           | `4.6.7`             | Already on zod 4 since #21 (imports bare `'zod'`, no `zod/v4` subpath). `aiEnvSchema`/`loadAIEnv` in `src/env.ts` (AI_* env, booleans via a `bool(def)` union+transform helper, not `.default()`), provider config/retry schemas in `src/config.ts` (`.default()` on numbers, booleans, arrays, `{}`), structured-output schemas in adapters/router/prompts. |

Consumers of `@meetops/config`: `apps/api`, `apps/worker`, `packages/queue` (they get the parsed `AppConfig`; type shape must stay identical).

Not used anywhere (no v4 work needed): `.merge`, `z.record`, `errorMap`, `required_error`/`invalid_type_error`, `.flatten()`/`.format()`, `.strict()`/`.passthrough()`, `.deepPartial()`, `z.nativeEnum`, `.superRefine`.

**Starting point: zod 3 and zod 4 already coexist.** Since #21 the lockfile has two copies: `zod@3.25.76` (config, notifications, web via `^3.23.8`) and `zod@4.6.7` (ai-core via `^4`). Each package imports bare `'zod'` and gets its own copy; nothing uses the `zod/v4` or `zod/v3` subpaths. No zod schema crosses a package boundary today (ai-core exports parsed types and its own schemas only to its own callers), so each remaining package can move from `^3.23.8` to `^4.6.6` independently, with no `zod/v4` subpath stage.

### Ownership of the AI_* env keys

**`packages/ai-core` owns the `AI_*` keys** (and the provider toggles `OLLAMA_ENABLED`, `LOCAL_STT_ENABLED`, `OPENAI_ENABLED`, `DEEPGRAM_ENABLED` and their URLs/keys). They are defined in `aiEnvSchema` (`packages/ai-core/src/env.ts`) and read at runtime only there (`loadAIEnv` → `ModelRouter`, e.g. `AI_REQUIRE_PROVIDER_APPROVAL`/`AI_ALLOW_PAID_FALLBACK` in `src/router.ts`). `packages/config` still declares copies in `envSchema`, but no app or package reads them from `AppConfig` (checked with `rg` on `01b1dab`), and they have already drifted (e.g. `AI_LLM_PROVIDER` enum is `gemini` only vs `gemini|ollama|openai`; `LOCAL_STT_URL` default `:8001` vs `:8000`). Plan: keep them in `packages/config` only until step 3, then remove them there (or mark `@deprecated`) so ai-core is the single source.

## ⚠️ MUST-TEST-BEFORE-MIGRATING: `.default()` boolean behaviour

**Do not bump `packages/config` to zod 4 until this test exists on zod 3 and passes. Add the ai-core test too: ai-core is already on zod 4, and it guards against anyone "simplifying" its `bool(def)` helper to `.default()`.**

In zod 3, `bool.default('true')` feeds `'true'` through the string→boolean transform, so the result is `true`. In zod 4, `.default()` short-circuits and returns the default value as-is, so the result would be the **string** `'true'` / `'false'`. A non-empty string is truthy, so `'false'` would behave like `true`.

Affected keys in `packages/config/src/index.ts` (all 8):

| Key                                | v3 default (boolean) | Why it matters                                              |
| ---------------------------------- | -------------------- | ----------------------------------------------------------- |
| **`AI_REQUIRE_PROVIDER_APPROVAL`** | `true`               | **Safety gate**: must stay a real boolean                   |
| **`AI_ALLOW_PAID_FALLBACK`**       | `false`              | **Cost gate**: `'false'` (truthy) would allow paid fallback |
| `STORAGE_FORCE_PATH_STYLE`         | `true`               | MinIO addressing                                            |
| `SMTP_SECURE`                      | `true`               | TLS for SMTP                                                |
| `OLLAMA_ENABLED`                   | `false`              | provider toggle                                             |
| `LOCAL_STT_ENABLED`                | `false`              | provider toggle                                             |
| `OPENAI_ENABLED`                   | `false`              | paid provider toggle                                        |
| `DEEPGRAM_ENABLED`                 | `false`              | paid provider toggle                                        |

Note: earlier drafts of this plan said 9 keys; the actual count is **8** (`grep -c 'bool.default' packages/config/src/index.ts` = 8).

Test to add in `packages/config/test/config.test.ts` (merge on v3 first, keep it through the migration):

```ts
const BOOL_DEFAULTS = {
  AI_REQUIRE_PROVIDER_APPROVAL: true,
  AI_ALLOW_PAID_FALLBACK: false,
  STORAGE_FORCE_PATH_STYLE: true,
  SMTP_SECURE: true,
  OLLAMA_ENABLED: false,
  LOCAL_STT_ENABLED: false,
  OPENAI_ENABLED: false,
  DEEPGRAM_ENABLED: false,
} as const;

it('boolean env defaults parse to real booleans', () => {
  const cfg = loadConfig({});
  for (const [key, expected] of Object.entries(BOOL_DEFAULTS)) {
    expect(typeof cfg[key as keyof typeof BOOL_DEFAULTS]).toBe('boolean');
    expect(cfg[key as keyof typeof BOOL_DEFAULTS]).toBe(expected);
  }
});

it.each(['false', '0', 'no', 'off'])('AI_ALLOW_PAID_FALLBACK=%s parses to false', (v) => {
  expect(loadConfig({ AI_ALLOW_PAID_FALLBACK: v }).AI_ALLOW_PAID_FALLBACK).toBe(false);
});
```

Test to add in `packages/ai-core/test/schemas-env.test.ts` (ai-core owns these keys; it is on zod 4 already, so this must pass now):

```ts
const AI_BOOL_DEFAULTS = {
  AI_REQUIRE_PROVIDER_APPROVAL: true,
  AI_ALLOW_PAID_FALLBACK: false,
  OLLAMA_ENABLED: false,
  LOCAL_STT_ENABLED: false,
  OPENAI_ENABLED: false,
  DEEPGRAM_ENABLED: false,
} as const;

it('AI_* boolean defaults parse to real booleans', () => {
  const { env, errors } = loadAIEnv({});
  expect(errors).toEqual([]);
  for (const [key, expected] of Object.entries(AI_BOOL_DEFAULTS)) {
    expect(typeof env[key as keyof typeof AI_BOOL_DEFAULTS]).toBe('boolean');
    expect(env[key as keyof typeof AI_BOOL_DEFAULTS]).toBe(expected);
  }
});

it.each(['false', '0', 'no', 'off', ''])('AI_ALLOW_PAID_FALLBACK=%j parses to false', (v) => {
  expect(loadAIEnv({ AI_ALLOW_PAID_FALLBACK: v }).env.AI_ALLOW_PAID_FALLBACK).toBe(false);
});

it.each(['true', '1', 'yes', 'on', ''])('AI_REQUIRE_PROVIDER_APPROVAL=%j parses to true', (v) => {
  expect(loadAIEnv({ AI_REQUIRE_PROVIDER_APPROVAL: v }).env.AI_REQUIRE_PROVIDER_APPROVAL).toBe(
    true,
  );
});
```

Fix during migration (packages/config): `bool.default(true)` / `bool.default(false)` (output-typed), or `.prefault('true')` to keep v3 semantics.

## Security: GHSA-mrhx-c7xc-m3w5 (fixed in zod 4.6.6)

[GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5) (high): zod can exhaust memory while validating oversized constrained collections. Affected: `zod < 4.6.6`, which includes **every 3.x release** (so `zod@3.25.76` in config, notifications and web). Patched: `4.6.6`.

- Only a real upgrade to `zod >= 4.6.6` fixes it. Importing the `zod/v4` subpath from a 3.25.x install does **not** (it ships the vulnerable code), which is one more reason this plan skips the subpath stage.
- Pin `"zod": "^4.6.6"` (not `^4`) in every package that moves, and tighten `packages/ai-core` from `^4` to `^4.6.6` in step 2 so a fresh resolve can never pick a vulnerable 4.x. Today ai-core resolves `4.6.7` (patched).
- After each step, confirm `pnpm-lock.yaml` resolves zod `>= 4.6.6` for the migrated package (`pnpm why zod`).
- **Rule until the upgrade lands:** no zod 3 schema (config, notifications, web) may validate untrusted request bodies or other attacker-controlled input. Today they only parse env vars (operator-controlled) and browser-side form input, so exposure is low; keep it that way.
- Any zod schema that does validate untrusted input (API bodies, webhook payloads, LLM output in ai-core) must cap collection sizes with `.max()` on arrays/records and string lengths, regardless of version.

## 2. v4 changes that affect this repo

| #   | Change in v4                                                                                                                                                                                                                           | Where it bites                                                                                                                                                                                                                                                                                                                                                                            | Severity                           |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| 1   | **`.default()` short-circuits**: default must be of the _output_ type and is returned without running the schema. `.prefault()` keeps v3 behaviour (default is parsed).                                                                | `packages/config`: `bool.default('true')` / `bool.default('false')` on a string→boolean transform. In v4 this is a type error and, if forced, returns the string `'true'` instead of `true`. 8 fields (`STORAGE_FORCE_PATH_STYLE`, `SMTP_SECURE`, `OLLAMA_ENABLED`, `LOCAL_STT_ENABLED`, `OPENAI_ENABLED`, `DEEPGRAM_ENABLED`, `AI_ALLOW_PAID_FALLBACK`, `AI_REQUIRE_PROVIDER_APPROVAL`). | **High** (silent behaviour change) |
| 2   | Defaults inside optional object fields are now applied (`z.string().default(x).optional()` yields `x`).                                                                                                                                | Not used today; watch in review.                                                                                                                                                                                                                                                                                                                                                          | Low                                |
| 3   | String formats moved to top level: `z.string().email()/.url()/.uuid()` deprecated in favour of `z.email()`, `z.url()`, `z.uuid()`. `.email()` regex is stricter; `z.url()` accepts any WHATWG URL (keeps `postgresql://`, `redis://`). | `config` (`DATABASE_URL`, `REDIS_URL`), `apps/web` auth schemas. Deprecated forms still work.                                                                                                                                                                                                                                                                                             | Low                                |
| 4   | Error customisation unified under `error`: `message` param deprecated (still accepted); `errorMap`, `invalid_type_error`, `required_error` removed.                                                                                    | `.refine(..., { message })` in config/notifications/web; `.min(n, 'msg')` string shorthand is still fine.                                                                                                                                                                                                                                                                                 | Low                                |
| 5   | `ZodError`: issue types renamed/merged (e.g. `invalid_string` → `invalid_format`, `too_small` fields tweaked), `.flatten()/.format()` deprecated for `z.treeifyError`/`z.prettifyError`; `error.message` text format differs.          | `config` embeds `result.error.message` in the thrown error; `notifications` maps `err.issues` (`path`, `message` stable). Tests/snapshots asserting message text may change.                                                                                                                                                                                                              | Medium                             |
| 6   | `z.record()` requires both key and value schemas; `.merge()` deprecated for `.extend()`/spread.                                                                                                                                        | Not used.                                                                                                                                                                                                                                                                                                                                                                                 | None                               |
| 7   | `z.coerce.*` input type is now `unknown`.                                                                                                                                                                                              | `z.coerce.number()` in config/notifications; only affects `z.input<>` types (not used).                                                                                                                                                                                                                                                                                                   | Low                                |
| 8   | Ecosystem: `@hookform/resolvers@3.10` does not support zod 4. Need `@hookform/resolvers@^5.1` (React Hook Form ≥7.55).                                                                                                                 | `apps/web` forms.                                                                                                                                                                                                                                                                                                                                                                         | Medium                             |

## 3. Effort

| Package                  | Estimate        | Notes                                                                                                                                 |
| ------------------------ | --------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/config`        | 0.5 day         | Fix 8 boolean defaults, swap to `z.url()`, `error:`; add tests for defaults (current test only checks `NODE_ENV`/`STORAGE_PROVIDER`). |
| `packages/notifications` | 0.25 day        | `message`→`error`, verify `formatIssues` output and tests.                                                                            |
| `apps/web`               | 0.5–1 day       | Bump `@hookform/resolvers` to v5, `z.email()`, re-run form tests (watch the `meetings.test.tsx` flake separately).                    |
| Lockfile / CI            | 0.25 day        | Drop `zod@3.25.76` once the last package moves; lockfile then has only `zod@4.x` (already present via ai-core).                       |
| **Total**                | **~1.5–2 days** |                                                                                                                                       |

## 4. Risks

- **Silent boolean flip in config** (change 1): `OLLAMA_ENABLED` etc. would become truthy strings. `AI_REQUIRE_PROVIDER_APPROVAL`/`AI_ALLOW_PAID_FALLBACK` are cost/safety gates. Mitigate with explicit tests per boolean default before the bump.
- **Error text changes** leaking into logs/tests; ensure no secret values appear (v4 issues can include `input` only when `reportInput` is on; keep it off).
- **Mixed versions**: `zod` 3 and 4 schemas are not interchangeable; a package exporting schemas to another must migrate together. Today no package exports zod schemas across workspaces (only parsed types), so per-package migration is safe.
- **Peer deps**: `.npmrc` has `strict-peer-dependencies=true`; resolver/RHF bump must satisfy peers or install fails.
- Bundle size in `apps/web` changes (v4 is smaller; `zod/mini` optional later).

## 5. Ordered steps

Starting point (after #21): ai-core is on `zod@^4` (4.6.7); config, notifications and web are on `zod@^3.23.8` (3.25.76); both copies are in the lockfile.

1. Add the MUST-TEST tests above: `packages/config` (8 booleans, plus `SMTP_PORT` → `465` and an invalid `DATABASE_URL` error) on zod 3, and `packages/ai-core` (AI_* booleans) on zod 4. Add `packages/notifications` `loadEmailConfig` happy/failure tests. Merge.
2. `packages/config`: change `"zod"` to `^4.6.6` (and tighten `packages/ai-core` from `^4` to `^4.6.6`) and keep the bare `'zod'` import. Change `bool.default('true')` → `bool.default(true)` (or `.prefault('true')`), `z.string().url()` → `z.url()`, `{ message }` → `{ error }`. Optionally use `z.prettifyError(result.error)` in `loadConfig`. Run tests/typecheck for api, worker, queue.
3. `packages/config`: remove (or `@deprecated`) the AI_* and provider-toggle keys that ai-core owns; point docs at `loadAIEnv`.
4. `packages/notifications`: `"zod": "^4.6.6"`; `{ message }` → `{ error }`; confirm `formatIssues` output.
5. `apps/web`: bump `@hookform/resolvers` to `^5.1` (+ `react-hook-form` if peers need it) and `"zod": "^4.6.6"` in the same PR; `z.email('...')`; run web tests and e2e auth flows.
6. `pnpm install` + `pnpm dedupe`; confirm `zod@3.25.76` is gone from `pnpm-lock.yaml` and the only resolved zod is `>= 4.6.6` (closes GHSA-mrhx-c7xc-m3w5). CI green (lint, typecheck, test, build). Update `docs/00-getting-started/environment-variables.md` if error messages or AI_* ownership are documented there.

Out of scope: env schemas stay in the package that reads them (config, notifications, ai-core). `@meetops/contracts` holds only domain types, API envelopes, pagination and job payloads, and is ARCH-owned ([ADR-003](../15-decisions/ADR-003-contracts-ownership.md)), so env schemas are not moved there.

## 6. Rollback

Each step is a separate PR; revert the PR. Because zod 3 and 4 already coexist, reverting one package's bump only restores its `^3.23.8` range and does not affect the others.
