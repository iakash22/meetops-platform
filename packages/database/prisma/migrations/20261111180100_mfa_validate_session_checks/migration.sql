-- ADR-021 (review #497): validate the sessions CHECKs that 20261111180000_mfa_totp added NOT VALID. VALIDATE CONSTRAINT
-- takes only SHARE UPDATE EXCLUSIVE, so logins and session reads/writes continue while existing rows are scanned.
-- Any existing row outside ('password', 'google', 'mfa') fails this migration loudly rather than being trusted.
-- Pre-check (auth_level NOT IN (...)) and recovery: docs/16-runbooks/mfa-session-checks-validate.md.
ALTER TABLE "sessions" VALIDATE CONSTRAINT "sessions_auth_level_check";
ALTER TABLE "sessions" VALIDATE CONSTRAINT "sessions_mfa_at_level_check";
