# Changelog

All notable changes to `@meetops/database` are documented here (format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)).

## [Unreleased]

### Added

- Migration `20261027130000_recording_session_bytes_received` (P1-DB-4): `recording_sessions.bytes_received`
  (`BIGINT NOT NULL DEFAULT 0`, CHECK 0..1_400_000_000 = contracts `MAX_RECORDING_SESSION_BYTES`) and
  `public.add_recording_session_bytes(uuid, bigint)`: SECURITY INVOKER, org-scoped via `app.current_org_id` under
  forced RLS, atomic and cap-safe under concurrency, EXECUTE granted to `meetops_app` only.
- `addRecordingSessionBytes(tx, sessionId, delta)` and `RECORDING_SESSION_BYTES_ERRORS`.
- `listMeetingsPage(tx, { limit, cursor })` keyset pagination (created_at DESC, id DESC) with
  `encodeMeetingsCursor` / `decodeMeetingsCursor` / `clampMeetingsLimit` (default 20, max 100).

### Notes

- No new meetings index: pagination reuses `meetings_org_id_created_at_id_idx` (20261026120000), which a backward
  index scan serves for DESC order. The WIP's partial DESC duplicate was dropped.
