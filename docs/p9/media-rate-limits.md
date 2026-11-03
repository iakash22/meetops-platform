# Media upload and recording-chunk rate limits

Follow-up to the P9 rate-limit coverage review (#416, `docs/p9/rate-limit-coverage.md` on `chore/p9-hardening`),
which listed media uploads and recording-session chunk URLs as unlimited. These routes are shared by the web app
(cookie session) and the extension / desktop apps (ADR-005 `recordings:write` bearer), so one set of limits covers
all three clients.

Implementation: `apps/api/src/modules/media/http/rate-limit.ts`, on the existing `RateLimiter` port (Redis fixed
windows in production, in-memory in tests). Checks run after authentication, so every key is an authenticated user
(or one of their recording sessions) plus the client IP. Over the limit: `429 RATE_LIMITED` with `Retry-After`
(seconds), via the shared domain error handler.

| Bucket              | Routes                                                                                                                   | Key          | Limit      |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------ | ---------- |
| `chunkPerSessionIp` | `POST /recording-sessions/:sessionId/chunks`                                                                             | session + IP | 150 / 30 s |
| `chunkPerUserIp`    | `POST /recording-sessions/:sessionId/chunks`                                                                             | user + IP    | 300 / 30 s |
| `controlPerUserIp`  | `POST /orgs/:org/uploads`, `.../uploads/:id/complete`, `POST /orgs/:org/recording-sessions`, `.../complete`, `.../abort` | user + IP    | 60 / 30 s  |

`GET .../download-url` is not a write path and is unchanged.

## Why these numbers

- **Live chunk cadence.** The extension records 5 s timeslices (`TIMESLICE_MS`, `apps/extension/src/lib/recorder.ts`)
  and only splits a slice into several seqs when it exceeds 8 MiB (`LOCAL_CHUNK_BYTES`), which opus audio at 5 s never
  approaches. Desktop records 10 s timeslices (`CHUNK_TIMESLICE_MS`, `apps/desktop/src/features/recording/recorder.ts`).
  So one live session presigns about 6 chunks per 30 s (12 in a pathological split case). 150 per 30 s per session
  is at least 12x that.
- **Backlog drain.** After a network outage both clients upload queued chunks back-to-back. 150 / 30 s lets a
  session drain at 5 presigns/s; a 1 h backlog (720 chunks) clears in under 3 minutes, and a throttled request is
  simply retried.
- **Retry-After stays under the client's patience.** 30 s windows cap `Retry-After` at 30 s, equal to the
  extension's `maxRetryAfterMs` (`apps/extension/src/lib/retry.ts`), which retries 429 honouring `Retry-After`. A
  longer window would make the extension give up on a drain instead of waiting.
- **Per user.** 300 / 30 s (10/s) leaves room for two concurrent sessions (extension + desktop) both draining at full
  speed, while bounding how fast one account can mint presigned PUT URLs.
- **Control routes** run a few times per recording or upload; 60 / 30 s per user is far above real use and blocks
  scripted creation of sessions / pending uploads.

Abuse ceilings that already exist (`MAX_CHUNK_BYTES`, `MAX_RECORDING_SESSION_BYTES`, `MAX_RECORDING_CHUNKS`) still
apply; these limits bound request rate, not bytes.

Tests: `apps/api/test/media-rate-limit.test.ts` (1 h at extension cadence passes; burst over the session limit gets
429 + Retry-After <= 30 s and recovers; per-session vs per-user vs other-user keying; control-route limit).
