# @meetops/extension

MeetOps AI Chrome extension (WXT, Manifest V3).

## Build-time configuration

The web and API origins are build-time settings read from WXT env vars (`.env*` files or the process environment).
See [`.env.example`](./.env.example).

| Variable         | Default                  | Used for                                                           |
| ---------------- | ------------------------ | ------------------------------------------------------------------ |
| `WXT_WEB_ORIGIN` | `https://app.meetops.ai` | Pairing page, and the only `externally_connectable` origin         |
| `WXT_API_ORIGIN` | `https://api.meetops.ai` | The only origin the bearer token is sent to (never presigned PUTs) |

`wxt.config.ts` validates both values when the build starts and fails on anything invalid. A value must be a bare
`https://host[:port]` origin with no path, trailing slash, query or credentials. `localhost` and other loopback hosts,
including over `http`, are accepted only in dev mode.

```sh
WXT_WEB_ORIGIN=https://app.staging.example WXT_API_ORIGIN=https://api.staging.example pnpm build
```

## Scripts

`pnpm dev`, `pnpm build`, `pnpm test`, `pnpm test:e2e`, `pnpm lint`, `pnpm typecheck`.
