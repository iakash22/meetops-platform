# Web E2E smoke

One Playwright test (`smoke.e2e.ts`) that drives the built web app through the core path:
sign-up → email verification → log in → create organization → open a meeting → upload a recording
(with the consent step) → transcript and summary on the meeting page.

## What is real and what is stubbed

| Part                                                | In this suite                                                                                                                                                                                 |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| API                                                 | Real `createServer()` from `apps/api/dist`, `NODE_ENV=test`, in-memory repositories (no Postgres, no Redis)                                                                                   |
| Web                                                 | Real `apps/web/dist`, served same-origin with `/api` proxied (`../flow/stack.ts`)                                                                                                             |
| Email                                               | `RecordingAuthMailer`: the test reads the verification token from it                                                                                                                          |
| Object storage                                      | `FakeMediaSigner` presigns `https://storage.example.test/...`; the test routes that host and records the PUT                                                                                  |
| STT / LLM (AssemblyAI, faster-whisper, Gemini, ...) | **Stubbed** by `FakePipeline.run()`: consumes the API's in-memory media job queue, writes a fixed transcript and report and marks the meeting completed. No provider, network call or API key |
| Meeting creation                                    | Seeded in the in-memory meetings repository: the API has no create-meeting route yet (the web "New meeting" dialog's `POST /orgs/:id/meetings` returns 404)                                   |

## Prerequisites

- Node and the workspace installed (`pnpm install`), and built API + web:
  `pnpm --filter @meetops/api... build && pnpm --filter @meetops/web build`
- A Chromium: either `pnpm --filter @meetops/tests e2e:install`, or point `E2E_CHROME_EXECUTABLE` at an
  installed Chrome/Chromium (e.g. `/usr/bin/google-chrome`).
- No services, databases or secrets. Leave `DATABASE_URL`, `REDIS_URL` and AI provider keys unset.

## Run

```sh
pnpm test:e2e:smoke                      # from the repo root
pnpm --filter @meetops/tests test:e2e:smoke
```

| Env                     | Default                       | Purpose                         |
| ----------------------- | ----------------------------- | ------------------------------- |
| `QA_API_DIR`            | `apps/api` of this checkout   | API whose `dist/` is started    |
| `QA_WEB_DIR`            | `apps/web` of this checkout   | web app whose `dist/` is served |
| `E2E_CHROME_EXECUTABLE` | unset (Playwright's Chromium) | browser binary to use           |
| `LOG_LEVEL`             | `silent`                      | API log level                   |

The test skips (with the reason) when either `dist/` is missing.
