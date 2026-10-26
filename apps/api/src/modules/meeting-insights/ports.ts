import type { Report, Transcript } from '@meetops/contracts';

/**
 * Read port for a meeting's transcript and report (Phase 3). Every method is scoped by the tenant's organizationId
 * (from the session, never from input); rows of another organization are indistinguishable from missing ones.
 */
export interface MeetingInsightsRepository {
  meetingExists(organizationId: string, meetingId: string): Promise<boolean>;
  /** Latest merged revision of the meeting's most recent recording, or null if none is merged yet. */
  latestTranscript(organizationId: string, meetingId: string): Promise<Transcript | null>;
  /** Highest non-deleted report version whose content passes ReportContent, or null. */
  latestReport(organizationId: string, meetingId: string): Promise<Report | null>;
}
