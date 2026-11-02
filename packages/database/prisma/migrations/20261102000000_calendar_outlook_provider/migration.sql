-- Phase 7: allow the Microsoft Outlook (Graph) calendar provider alongside Google.
-- Widening only (no data change); safe to apply before the code that writes 'outlook' ships.
ALTER TABLE "calendar_connections" DROP CONSTRAINT "calendar_connections_provider_check";
ALTER TABLE "calendar_connections"
  ADD CONSTRAINT "calendar_connections_provider_check" CHECK ("provider" IN ('google', 'outlook'));

ALTER TABLE "calendar_events" DROP CONSTRAINT "calendar_events_provider_check";
ALTER TABLE "calendar_events"
  ADD CONSTRAINT "calendar_events_provider_check" CHECK ("provider" IN ('google', 'outlook'));
