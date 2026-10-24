# Plan: migrate to Zod 4

Status: proposal. Owner: DevOps (packages/config), with Notifications and Web owners for their packages.
Baseline: `integration/phase-1` @ `8da9449`.

## 1. Inventory

| Workspace                | Declared range | Resolved (lockfile) | Zod usage                                                                                                                              |
| ------------------------ | -------------- | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/config`        | `^3.23.8`      | `3.25.76`           | `envSchema` (`z.object`, `z.enum`, `z.coerce.number`, `.url()`, `.default()`, `.refine`/`.transform`), `safeParse`, `error.message`    |
| `packages/notifications` | `^3.23.8`      | `3.25.76`           | SMTP/console env schemas, `.refine({ message })`, `.default()`, `.optional()`, `z.ZodError` + `err.issues` formatting                  |
| `apps/web`               | `^3.23.8`      | `3.25.76`           | Auth/org form schemas (`.min(n, 'msg')`, `.email('msg')`, `.refine({ path, message })`) via `@hookform/resolvers@3.10.0` `zodResolver` |
| `packages/ai-core`       | none           | -                   | Only a comment mentions zod; no dependency.                                                                                            |

Consumers of `@meetops/config`: `apps/api`, `apps/worker`, `packages/queue` (they get the parsed `AppConfig`; type shape must stay identical).

Not used anywhere (no v4 work needed): `.merge`, `z.record`, `errorMap`, `required_error`/`invalid_type_error`, `.flatten()`/`.format()`, `.strict()`/`.passthrough()`, `.deepPartial()`, `z.nativeEnum`, `.superRefine`.

`zod@3.25.x` already ships v4 at the `zod/v4` subpath, so packages can migrate one at a time before bumping to `zod@^4`.

## ⚠️ MUST-TEST-BEFORE-MIGRATING: `.default()` boolean behaviour

**Do not bump zod or switch any import to `zod/v4` in `packages/config` until this test exists on v3 and passes.**

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

Fix during migration: `bool.default(true)` / `bool.default(false)` (output-typed), or `.prefault('true')` to keep v3 semantics.

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
| Lockfile / CI            | 0.25 day        | Single `zod@^4` across workspace; dedupe.                                                                                             |
| **Total**                | **~1.5–2 days** |                                                                                                                                       |

## 4. Risks

- **Silent boolean flip in config** (change 1): `OLLAMA_ENABLED` etc. would become truthy strings. `AI_REQUIRE_PROVIDER_APPROVAL`/`AI_ALLOW_PAID_FALLBACK` are cost/safety gates. Mitigate with explicit tests per boolean default before the bump.
- **Error text changes** leaking into logs/tests; ensure no secret values appear (v4 issues can include `input` only when `reportInput` is on; keep it off).
- **Mixed versions**: `zod` 3 and 4 schemas are not interchangeable; a package exporting schemas to another must migrate together. Today no package exports zod schemas across workspaces (only parsed types), so per-package migration is safe.
- **Peer deps**: `.npmrc` has `strict-peer-dependencies=true`; resolver/RHF bump must satisfy peers or install fails.
- Bundle size in `apps/web` changes (v4 is smaller; `zod/mini` optional later).

## 5. Ordered steps

1. Add regression tests in `packages/config` for every default (esp. the 8 booleans → `boolean`, `SMTP_PORT` → `465`) and for an invalid `DATABASE_URL` error. Same for `packages/notifications` `loadEmailConfig` happy/failure paths. Merge on v3.
2. `packages/config`: import from `zod/v4` (still on 3.25.x). Change `bool.default('true')` → `bool.default(true)` (or `.prefault('true')`), `z.string().url()` → `z.url()`, `{ message }` → `{ error }`. Optionally use `z.prettifyError(result.error)` in `loadConfig`. Run tests/typecheck for api, worker, queue.
3. `packages/notifications`: same import switch; `{ message }` → `{ error }`; confirm `formatIssues` output.
4. `apps/web`: bump `@hookform/resolvers` to `^5.1` (+ `react-hook-form` if needed), switch to `zod/v4`, `z.email('...')`; run web tests and e2e auth flows.
5. Bump all three to `"zod": "^4"`, change imports back to `'zod'`, `pnpm install`, `pnpm dedupe`; confirm only one zod in `pnpm-lock.yaml`.
6. CI green (lint, typecheck, test, build); update `docs/00-getting-started/environment-variables.md` if any error messages are documented.
7. Follow-ups (optional): `zod/mini` for web bundle; move shared env schemas into `@meetops/contracts` only if needed.

## 6. Rollback

Each step is a separate PR; revert the PR. Until step 5, the dependency remains `zod@3.25.x`, so rollback is code-only.
