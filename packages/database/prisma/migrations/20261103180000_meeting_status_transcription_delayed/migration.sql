-- Meeting status for transcription jobs whose retries are used up (dead-lettered).
-- ADD VALUE is not reversible in Postgres; rollback leaves the unused value in place.
ALTER TYPE "MeetingStatus" ADD VALUE IF NOT EXISTS 'transcription_delayed';
