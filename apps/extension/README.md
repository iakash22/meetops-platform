# @meetops/extension

MeetOps AI Chrome extension (WXT, Manifest V3).

## Build-time configuration

The web and API origins are build-time settings read from WXT env vars (`.env*` files or the process environment).
See [`.env.example`](./.env.example).

| Variable                  | Default                                                         | Used for                                                           |
| ------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------ |
| `WXT_WEB_ORIGIN`          | `https://app.meetops.ai`                                        | Pairing page, and the only `externally_connectable` origin         |
| `WXT_API_ORIGIN`          | `https://api.meetops.ai`                                        | The only origin the bearer token is sent to (never presigned PUTs) |
| `WXT_FEATURE_HTTP_UPLOAD` | on in development builds; off in production builds and in tests | `true`/`1` force the HTTP client; `false`/`0` force the stub       |
| `WXT_PRIVACY_URL`         | unset (link hidden)                                             | Privacy Policy link in the popup and the options page              |

`wxt.config.ts` validates `WXT_WEB_ORIGIN` and `WXT_API_ORIGIN` when the build starts and fails on anything invalid. A value must be a bare
`https://host[:port]` origin with no path, trailing slash, query or credentials. `localhost` and other loopback hosts,
including over `http`, are accepted only in dev mode.

`WXT_PRIVACY_URL` is an absolute `https://` URL, or a path that is resolved against `WXT_WEB_ORIGIN`. The popup and the
options page show the link only when it is set; the link opens in a new tab and stays keyboard-accessible. Production
builds (`wxt build`) warn, but do not fail, if it is missing.

```sh
WXT_WEB_ORIGIN=https://app.staging.example WXT_API_ORIGIN=https://api.staging.example pnpm build
```

## Upload client (`WXT_FEATURE_HTTP_UPLOAD`)

`HttpUploadClient` (`src/lib/upload-http.ts`) calls the contracts recording-session routes and is the default in
development builds (`pnpm dev` / `wxt build --mode development`). Production builds (`pnpm build` / `wxt build`)
keep the previous default: `StubUploadClient` (no backend calls) unless the flag is set to `true` or `1`. Tests
always use the stub so they stay deterministic and never touch the network. Force the stub in dev with
`WXT_FEATURE_HTTP_UPLOAD=false` (or `0`).

When the HTTP client is on, the popup also asks the background to find or create the meeting with
`POST /orgs/:organizationId/meetings/resolve` (tab URL reduced to origin + path; query strings such as Zoom
`pwd=` never leave the browser). With the stub, a fresh random UUID is used instead.

Routes used by `HttpUploadClient`:

| Op               | Route                                             |
| ---------------- | ------------------------------------------------- |
| init             | `POST /orgs/:organizationId/recording-sessions`   |
| chunk upload URL | `POST /recording-sessions/:sessionId/chunks`      |
| complete         | `POST /recording-sessions/:sessionId/complete`    |
| abort            | `POST /recording-sessions/:sessionId/abort` (204) |

- API calls go through `auth.apiFetch()` (ADR-005 bearer, API origin only, one refresh on 401). The organization
  is the paired token's. Presigned PUTs go through the fetch transport and never carry a bearer or cookies.
- Requests and responses are checked with `Value.Check` against the contracts schemas (`uploadValidators`).
- Checksums: each chunk's lowercase hex sha256 is sent with the chunk URL request. The signed
  `x-amz-checksum-sha256` must equal its base64 form, and the body is re-hashed before the PUT
  (`verifyingStorage`).
- Retries: 408/429/5xx and network errors, with capped exponential backoff and jitter (4 attempts by default)
  and `Retry-After`. Other 4xx responses fail right away. A failed session stays in IndexedDB, and the next queue
  drain retries it. A storage 403 re-requests the URL once. Uploaded chunks are deleted, since the client is
  `durable`.
- The offscreen recorder can't read the session tokens. It proxies API calls to the background worker as
  `UPLOAD_RPC` messages (`src/lib/upload-rpc.ts`), which the worker accepts only from the offscreen document and
  only when the flag is on. The worker validates each message. The PUT itself still runs in the offscreen
  document.

## Scripts

`pnpm dev`, `pnpm build`, `pnpm test`, `pnpm test:e2e`, `pnpm lint`, `pnpm typecheck`.
