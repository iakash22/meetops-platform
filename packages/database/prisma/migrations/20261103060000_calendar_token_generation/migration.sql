-- Phase 7 calendar token hardening (#394 N1/N2).
-- token_generation: compare-and-set fence for token writes. Every token write (API refresh, worker refresh,
-- reconnect, revoke) bumps it; a refresh only writes while it still equals the generation it read, so a slow
-- refresh can never overwrite a newer grant or a concurrent refresh's rotated refresh token.
-- refresh_enc_version: AAD context the stored refresh_token_enc was sealed under (1 = pre-v2 shared org+id
-- context, 2 = per-field `calendar:<id>:refresh`). NULL = written before this migration (readers infer it).
-- Additive with constant defaults (metadata-only ALTER, no rewrite); existing table grants cover the columns.
ALTER TABLE "calendar_connections"
  ADD COLUMN "token_generation" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "refresh_enc_version" SMALLINT;

ALTER TABLE "calendar_connections"
  ADD CONSTRAINT "calendar_connections_refresh_enc_version_check"
  CHECK ("refresh_enc_version" IS NULL OR "refresh_enc_version" IN (1, 2)),
  ADD CONSTRAINT "calendar_connections_token_generation_check"
  CHECK ("token_generation" >= 0);
