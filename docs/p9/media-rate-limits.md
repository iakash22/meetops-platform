# Media upload and recording-chunk rate limits

Follow-up to the P9 rate-limit coverage review (#416, `docs/p9/rate-limit-coverage.md` on `chore/p9-hardening`),
which listed media uploads and recording-session chunk URLs as unlimited. These routes are shared by the web app
(cookie session) and the extension / desktop apps (ADR-005 `recordings:write` bearer), so one set of limits covers
all three clients.

Implementation: `apps/api/src/modules/media/http/rate-limit.ts`, on the existing `RateLimiter` port (Redis fixed
windows in production, in-memory in tests). Checks run after authentication, so every key is an authenticated user
(or one of their recording sessions) plus the client IP. Over the limit: `429 RATE_LIMITED` with `Retry-After`
(seconds), via the shared domain error handler.

| Bucket              | Routes                                                      | Key                       | Limit      | Charged                   |
| ------------------- | ----------------------------------------------------------- | ------------------------- | ---------- | ------------------------- |
| `chunkPerUser`      | `POST /recording-sessions/:sessionId/chunks`                | user (any IP)             | 450 / 30 s | after auth                |
| `chunkPerUserIp`    | `POST /recording-sessions/:sessionId/chunks`                | user + IP                 | 300 / 30 s | after auth                |
| `chunkPerSessionIp` | `POST /recording-sessions/:sessionId/chunks`                | org + user + session + IP | 150 / 30 s | after the ownership check |
| `controlPerUser`    | upload init/complete, recording-session init/complete/abort | user (any IP)             | 90 / 30 s  | after auth                |
| `controlPerUserIp`  | upload init/complete, recording-session init/complete/abort | user + IP                 | 60 / 30 s  | after auth                |

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
- **Per user + IP.** 300 / 30 s (10/s) leaves room for two concurrent sessions on one network (extension + desktop)
  both draining at full speed, while bounding how fast one account can mint presigned PUT URLs.
- **Per user, any IP.** 450 / 30 s (15/s) = three sessions draining at the full per-session rate from different
  networks (e.g. extension at the office, desktop on a hotspot, a retry after a network switch). It is keyed on the
  user id only, so rotating source IPs cannot raise one account above it; the per-IP bucket stays as the tighter
  limit for a single network. Live recording needs about 0.2-0.4 presigns/s, so this is ~40x headroom.
- **Control routes** run a few times per recording or upload; 60 / 30 s per user is far above real use and blocks
  scripted creation of sessions / pending uploads.

## Tenant isolation of the session bucket

The per-session bucket is charged only after `RecordingSessionService.own()` has confirmed the session belongs to
the caller's org and the caller may update it, and its key includes the org and user id
(`media:chunk:org:<org>:user:<user>:session:<id>:ip:<ip>`). A user from another org who hammers a session id gets
the normal 404 and only charges their own per-user buckets, so they cannot drain the owner's session bucket (and the
404 is not turned into a 429 that would reveal the session exists).

## Limiter unavailable: fail closed

If the limiter backend (Redis) throws, these routes answer `503 PROVIDER_UNAVAILABLE` with `Retry-After: 5` and do
nothing else (no session, upload row or presigned URL is created).

- **Why closed, not open.** These routes mint presigned PUT URLs and create storage-backed rows; failing open would
  turn a Redis outage (or an attacker who can cause one) into unmetered URL minting and storage writes, which is the
  exact abuse this limit exists to stop. Auth routes already depend on Redis the same way.
- **Why this does not lose recordings.** The extension and desktop clients keep chunks locally and retry 5xx with
  backoff (the extension honours `Retry-After`), so a short Redis blip delays the upload drain; it does not drop data.
  A long outage leaves chunks queued on the device until Redis is back (the extension's IndexedDB cap is 500 MiB).
- **Operator impact.** While Redis is down, new uploads and recording sessions cannot start and in-progress
  recordings stop uploading (they keep recording locally). Expect a spike of 503s on `/recording-sessions/*` and
  `/orgs/:org/uploads*`; alert on Redis availability, not on the 503s themselves. No manual cleanup is needed after
  recovery: clients drain on their own.

Abuse ceilings that already exist (`MAX_CHUNK_BYTES`, `MAX_RECORDING_SESSION_BYTES`, `MAX_RECORDING_CHUNKS`) still
apply; these limits bound request rate, not bytes.

Tests: `apps/api/test/media-rate-limit.test.ts` (1 h at extension cadence passes; burst over the session limit gets
429 + Retry-After <= 30 s and recovers; per-session vs per-user vs other-user keying; control-route limit; a
cross-org user cannot drain a session or get past the ownership check; limiter down -> 503 + Retry-After; extension
bearer path with rotating IPs hits the IP-independent per-user bucket).
