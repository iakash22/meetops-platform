/**
 * Test doubles for the parts of the stack that a browser smoke test can't reach without real infrastructure:
 *  - object storage: the in-memory FakeMediaSigner presigns `https://storage.example.test/<key>`; the test routes
 *    that host and records the PUT on the signer, so `complete` sees the object.
 *  - the worker's STT + LLM steps (AssemblyAI / faster-whisper, Gemini): replaced by a deterministic stub that
 *    consumes the API's in-memory media job queue and writes a transcript and report, then marks the meeting
 *    completed. No AI provider, network call or API key is involved.
 */
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Page, Route } from '@playwright/test';
import { apiDir } from '../flow/stack.js';

type Job = { kind: string; organizationId: string; meetingId?: string; subjectId: string };
type Signer = { put(key: string, sizeBytes: number): void };
type MediaAdapters = { signer: Signer; jobs: { jobs: Job[] } } & Record<string, unknown>;
type MeetingRow = { status: string; endedAt: Date | null; updatedAt: Date };
type Meetings = {
  rows: Map<string, MeetingRow>;
  seed(row: { organizationId: string; title: string; source: string; startedAt: Date }): {
    id: string;
  };
};
type Insights = {
  addMeeting(o: string, m: string): void;
  setTranscript(o: string, t: unknown): void;
  setReport(r: unknown): void;
};

const dist = (...p: string[]) => pathToFileURL(join(apiDir!, 'dist', ...p)).href;

export const STUB = {
  speaker: 'Stub Speaker',
  line: 'Stub transcript line: kickoff for the smoke test.',
  summary: 'Stub summary: the team agreed to ship the smoke suite.',
  decision: 'Ship the E2E smoke suite',
  action: 'Wire the smoke suite into CI',
};

export class FakePipeline {
  private constructor(
    readonly media: MediaAdapters,
    readonly meetings: Meetings,
    readonly insights: Insights,
  ) {}

  static async create(): Promise<FakePipeline> {
    const { inMemoryMediaAdapters } = (await import(dist('modules', 'index.js'))) as {
      inMemoryMediaAdapters: () => MediaAdapters;
    };
    const { InMemoryMeetingRepository } = (await import(
      dist('modules', 'meetings', 'infrastructure', 'in-memory.repository.js')
    )) as { InMemoryMeetingRepository: new () => Meetings };
    const { InMemoryMeetingInsights } = (await import(
      dist('modules', 'meeting-insights', 'in-memory.repository.js')
    )) as { InMemoryMeetingInsights: new () => Insights };
    return new FakePipeline(
      inMemoryMediaAdapters(),
      new InMemoryMeetingRepository(),
      new InMemoryMeetingInsights(),
    );
  }

  /** API deps for `new Stack(deps)`. */
  get deps(): Record<string, unknown> {
    return { media: this.media, meetings: this.meetings, meetingInsights: this.insights };
  }

  /** Accept the browser's presigned PUT (and its CORS preflight) and record it on the fake signer. */
  async routeStorage(page: Page, origin: string): Promise<void> {
    const cors = {
      'access-control-allow-origin': origin,
      'access-control-allow-methods': 'PUT, GET',
      'access-control-allow-headers': '*',
    };
    await page.route('https://storage.example.test/**', async (route: Route) => {
      const req = route.request();
      if (req.method() === 'PUT') {
        const key = decodeURIComponent(new URL(req.url()).pathname.slice(1));
        this.media.signer.put(key, req.postDataBuffer()?.length ?? 0);
      }
      await route.fulfill({ status: 200, headers: cors, body: '' });
    });
  }

  /** An upload meeting in the in-memory repository (the API has no create-meeting route yet). */
  seedMeeting(organizationId: string, title: string): { id: string } {
    return this.meetings.seed({ organizationId, title, source: 'upload', startedAt: new Date() });
  }

  /** Stub STT + LLM: process every queued upload job; returns the meeting ids it completed. */
  run(): string[] {
    const done: string[] = [];
    for (const job of this.media.jobs.jobs.splice(0)) {
      if (job.kind !== 'process_upload' || !job.meetingId) continue;
      const { organizationId: org, meetingId } = job;
      const now = new Date();
      this.insights.addMeeting(org, meetingId);
      this.insights.setTranscript(org, {
        id: randomUUID(),
        meetingId,
        recordingId: job.subjectId,
        language: 'en',
        provider: 'faster-whisper',
        providerJobId: 'stub',
        segments: [
          {
            id: randomUUID(),
            index: 0,
            startMs: 0,
            endMs: 4000,
            speaker: STUB.speaker,
            text: STUB.line,
          },
        ],
        createdAt: now.toISOString(),
      });
      this.insights.setReport({
        id: randomUUID(),
        organizationId: org,
        meetingId,
        summary: STUB.summary,
        decisions: [STUB.decision],
        risks: [],
        actionItems: [{ title: STUB.action }],
        aiRunId: null,
        createdAt: now.toISOString(),
      });
      const row = this.meetings.rows.get(meetingId);
      if (row) Object.assign(row, { status: 'completed', endedAt: now, updatedAt: now });
      done.push(meetingId);
    }
    return done;
  }
}
