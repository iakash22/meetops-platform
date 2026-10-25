# @meetops/extension

MeetOps AI Chrome extension (WXT, Manifest V3).

## Build-time configuration

The web and API origins are build-time settings read from WXT env vars (`.env*` files or the process environment).
See [`.env.example`](./.env.example).

| Variable                  | Default                  | Used for                                                                   |
| ------------------------- | ------------------------ | -------------------------------------------------------------------------- |
| `WXT_WEB_ORIGIN`          | `https://app.meetops.ai` | Pairing page, and the only `externally_connectable` origin                 |
| `WXT_API_ORIGIN`          | `https://api.meetops.ai` | The only origin the bearer token is sent to (never presigned PUTs)         |
| `WXT_FEATURE_HTTP_UPLOAD` | off                      | `true`/`1`: use the real recording-session HTTP client instead of the stub |

`wxt.config.ts` validates both values when the build starts and fails on anything invalid. A value must be a bare
`https://host[:port]` origin with no path, trailing slash, query or credentials. `localhost` and other loopback hosts,
including over `http`, are accepted only in dev mode.

```sh
WXT_WEB_ORIGIN=https://app.staging.example WXT_API_ORIGIN=https://api.staging.example pnpm build
```

## Upload client (`WXT_FEATURE_HTTP_UPLOAD`)

`StubUploadClient` (no backend calls) is the default. Building with `WXT_FEATURE_HTTP_UPLOAD=true` switches to
`HttpUploadClient` (`src/lib/upload-http.ts`), which calls the contracts recording-session routes:

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
