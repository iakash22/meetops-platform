-- Phase 7 background sync: per-connection incremental sync cursor (Outlook delta link; Google later).
-- The cursor is an opaque provider URL/token that can replay the user's calendar changes, so it is stored as a
-- TokenCipher v1 envelope (AAD `calendar:<id>:cursor`), never in plaintext. sync_cursor_from/to are the window the
-- cursor's round was opened for. All nullable and additive (metadata-only ALTER, no rewrite); existing table grants
-- (meetops_app SELECT/INSERT/UPDATE) already cover the new columns.
ALTER TABLE "calendar_connections"
  ADD COLUMN "sync_cursor_enc" TEXT,
  ADD COLUMN "sync_cursor_from" TIMESTAMPTZ(3),
  ADD COLUMN "sync_cursor_to" TIMESTAMPTZ(3);

ALTER TABLE "calendar_connections"
  ADD CONSTRAINT "calendar_connections_sync_cursor_envelope_check"
  CHECK ("sync_cursor_enc" IS NULL OR "sync_cursor_enc" ~ '^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$'),
  ADD CONSTRAINT "calendar_connections_sync_cursor_window_check"
  CHECK (("sync_cursor_enc" IS NULL) OR ("sync_cursor_from" IS NOT NULL AND "sync_cursor_to" > "sync_cursor_from"));
