-- MeetingSource gains 'mobile' (native mobile app recordings). Additive only; the new value is not used in this
-- transaction, so ADD VALUE is safe inside Prisma's migration transaction (Postgres 12+). Rollback = leave it unused.
ALTER TYPE "MeetingSource" ADD VALUE IF NOT EXISTS 'mobile';
