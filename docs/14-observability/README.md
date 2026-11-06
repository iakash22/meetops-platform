# 14 — Observability

## Signals

| Signal  | Source                                                                                                                                                                                                                            |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Logs    | `@meetops/logger` (pino JSON). Request ids, no secrets or query strings (redacted), names-only errors.                                                                                                                            |
| Health  | API `GET /health` (liveness) and `GET /ready` (Postgres + Redis; 503 when either is down).                                                                                                                                        |
| Metrics | API `GET /metrics` (`apps/api/src/shared/metrics.ts`): `http_requests_total`, `http_request_duration_seconds`, process gauges. Off unless `METRICS_TOKEN` (>= 32 chars); Bearer auth; 404 otherwise.                              |
| Metrics | Worker exporter (`apps/worker/src/metrics.ts`): `bullmq_queue_jobs{queue,state}`, `bullmq_queue_scrape_error{queue}`. Off unless `WORKER_METRICS_TOKEN`; loopback by default (`WORKER_METRICS_HOST`, `WORKER_METRICS_PORT`=9464). |
| Product | `meeting.transcription_delayed` notifications (ADR-013 outbox) for DLQ'd transcription.                                                                                                                                           |

Labels never carry ids, tokens, emails or raw URLs: routes are templates, queues are fixed names.

## Alerts

Rules live in `infra/monitoring/prometheus/` and are described, with runbook sections, in [alerts.md](alerts.md):
5xx rate, p95 latency, `/ready` failures, API down/memory/restarts, queue backlog, failed jobs, transcription DLQ and
scrape errors. **The alert destination is a placeholder** (`alertmanager.example.yml`) until Akash decides.

## Not yet

Tracing (OpenTelemetry) and error tracking are not wired. Realtime has no metrics endpoint yet.
