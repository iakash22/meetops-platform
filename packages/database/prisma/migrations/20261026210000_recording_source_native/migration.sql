-- contracts 0.6.0: RecordingSource gains 'mobile' (native app, PR #173) and 'desktop' (PRs #176/#180).
-- Additive only. ALTER TYPE ... ADD VALUE runs inside Prisma's migration transaction on Postgres 12+, as long as
-- the new values are not used in the same transaction (they are not). Existing 'tab' rows are untouched.
-- Enum values cannot be removed without recreating the type: rolling back means leaving them unused.
ALTER TYPE "RecordingSource" ADD VALUE IF NOT EXISTS 'mobile';
ALTER TYPE "RecordingSource" ADD VALUE IF NOT EXISTS 'desktop';
