import type { Report, Transcript } from '@meetops/contracts';
import type { MeetingInsightsRepository } from './ports.js';

type Key = `${string}/${string}`;
const key = (o: string, m: string): Key => `${o}/${m}`;

/** Development/test only. Seed with `addMeeting` / `setTranscript` / `setReport`. */
export class InMemoryMeetingInsights implements MeetingInsightsRepository {
  private readonly meetings = new Set<Key>();
  private readonly transcripts = new Map<Key, Transcript>();
  private readonly reports = new Map<Key, Report>();

  addMeeting(organizationId: string, meetingId: string) {
    this.meetings.add(key(organizationId, meetingId));
  }
  setTranscript(organizationId: string, t: Transcript) {
    this.transcripts.set(key(organizationId, t.meetingId), t);
  }
  setReport(r: Report) {
    this.reports.set(key(r.organizationId, r.meetingId), r);
  }

  meetingExists(o: string, m: string) {
    return Promise.resolve(this.meetings.has(key(o, m)));
  }
  latestTranscript(o: string, m: string) {
    return Promise.resolve(this.transcripts.get(key(o, m)) ?? null);
  }
  latestReport(o: string, m: string) {
    return Promise.resolve(this.reports.get(key(o, m)) ?? null);
  }
}
