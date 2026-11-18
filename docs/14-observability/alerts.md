# Alert rules (P9 item #13)

Rules: [`api-alerts.rules.yml`](../../infra/monitoring/prometheus/api-alerts.rules.yml) (5xx rate, latency, `/ready`
failures, down, memory, restarts) and [`worker-alerts.rules.yml`](../../infra/monitoring/prometheus/worker-alerts.rules.yml)
(queue depth, failed jobs, transcription DLQ, scrape errors). Routing: [`alertmanager.example.yml`](../../infra/monitoring/prometheus/alertmanager.example.yml),
**placeholder receivers only**.
Scrape example: [`scrape.example.yml`](../../infra/monitoring/prometheus/scrape.example.yml). Metrics source:
`apps/api/src/shared/metrics.ts` (`/metrics` is off unless `METRICS_TOKEN` is set, >= 32 chars, Bearer auth).
`apps/api/test/alert-rules.test.ts` fails if a rule references a metric the API does not emit, drops the
`job="meetops-api"` scope, or lacks a severity, summary or runbook section below.

**Severities:** `page` = wake someone; `ticket` = next working day. **Routing (Alertmanager receivers: email,
pager) is needs-owner** (Akash: alert destination, `docs/p9/remaining-work.md` owner decision 5). Until then, load
the rules and check them on the Prometheus _Alerts_ page.

Validate locally (no install needed when Docker is available; pulls the public image, builds nothing):

```bash
docker run --rm --network host -v "$PWD/infra/monitoring/prometheus:/r:ro" --entrypoint promtool \
  prom/prometheus:latest check rules /r/api-alerts.rules.yml
```

Worker exporter (`apps/worker/src/metrics.ts`): off unless `WORKER_METRICS_TOKEN` (>= 32 chars) is set; then
`GET /metrics` with `Authorization: Bearer <token>` on `WORKER_METRICS_HOST` (default `127.0.0.1`) :
`WORKER_METRICS_PORT` (default `9464`). It emits `bullmq_queue_jobs{queue,state}` and
`bullmq_queue_scrape_error{queue}`; labels are queue names and states only. `apps/worker/test/queue-metrics.test.ts`
guards the worker rules the same way the API test guards the API rules.

**Alert destination: PLACEHOLDER.** `alertmanager.example.yml` routes `page` to `placeholder-page` and everything else
to `placeholder-ticket`; neither has a receiver config, so nothing is delivered until Akash picks a destination.

## MeetOpsApiDown

`up == 0` for 2m: Prometheus cannot scrape the API. Check the container/process is running, `GET /health`, and that
the scrape token file matches `METRICS_TOKEN` (a wrong token returns 404, which also reads as down). Roll back to the
previous image tag if a deploy just happened (`docs/p9/release-checklist.md` §2).

## MeetOpsApiHigh5xxRate

More than 5% of requests return 5xx for 5m (ignored under 0.1 req/s). Group `http_requests_total` by `route` to
find the failing route template; check API logs (request ids) and `/ready`. DB or Redis outages usually also fire
MeetOpsApiNotReady.

## MeetOpsApiHighLatencyP95

p95 above 1s for 10m (excluding `/metrics`, `/health`, `/ready`). Break down
`http_request_duration_seconds_bucket` by `route`; check Postgres slow queries and Redis latency. Uploads stream
through presigned URLs, so slow upload routes point at the API itself, not object storage.

## MeetOpsApiNotReady

`/ready` returned only 503 for 3m+ (no 200s). The API cannot reach Postgres or Redis. Check
`DATABASE_URL`/`REDIS_URL` connectivity, connection limits, and the database/Redis health. Load balancers should be
draining this instance already.

## MeetOpsApiMemoryHigh

RSS above 1.5 GB for 15m. Compare `nodejs_heap_used_bytes`; a growing heap suggests a leak (take a heap snapshot on
a canary), a flat heap with high RSS suggests buffers. Restart is a mitigation, not a fix; open an issue.

## MeetOpsApiRestarting

`process_uptime_seconds` reset 3+ times in 30m: crash loop or OOM kill. Check the container exit code and the last
log lines before each restart; startup env validation (`loadConfig`) failures show up here.

## MeetOpsWorkerDown

`up == 0` for the worker exporter. Check the worker process and that the token file matches `WORKER_METRICS_TOKEN`.

## MeetOpsQueueBacklog

More than 100 waiting jobs on one queue for 10m (every `*-dlq` queue excluded). Check the worker is consuming that queue (its feature
flag is on, logs show `worker jobs registered`), then the provider rate limits for `transcription`/`ai`. Scale workers
only after ruling out a stuck job.

## MeetOpsQueueFailedJobsRising

The failed set grew by 10+ in 15m. Inspect recent failed jobs (error names, not payloads) and the provider status. STT
has one provider per org and no fallback, so provider outages show here by design.

## MeetOpsTranscriptionDlqNotEmpty

Transcription DLQ entries older than 30m. Follow `docs/16-runbooks/transcription-dlq-redrive.md`.

## MeetOpsTakeoverFollowUpDlqNotEmpty

An account-takeover follow-up (realtime kick, extension/desktop token revocation or push-device revocation) used up
its 6 attempts and was dead-lettered to `auth-takeover-follow-up-dlq`. The takeover itself committed, but one
revocation may still be outstanding for that user, so treat it as security-relevant. Fix the failing dependency (the
API log `auth.takeover.follow_up_abandoned` names the kind), then follow
`docs/16-runbooks/takeover-follow-up-dlq-redrive.md`. The worker reads this queue under `AUTH_MAIL_QUEUE_PREFIX`, so
set it to the API's value or the gauge reads an empty queue.

## MeetOpsQueueScrapeError

The exporter cannot read BullMQ counts (usually Redis). Check `REDIS_URL` connectivity and Redis memory/eviction.
