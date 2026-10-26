import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import { ApiErrorEnvelope, Report, Transcript } from '@meetops/contracts';
import { InMemoryMeetingInsights } from '../src/modules/meeting-insights/in-memory.repository.js';
import { selectMeetingInsightsRepository } from '../src/modules/meeting-insights/index.js';
import { MissingProductionDependencyError, type ModuleDeps } from '../src/modules/index.js';
import { buildApp, signupAndLogin, type App, type Client } from './helpers.js';

const MEET = '00000000-0000-4000-8000-0000000000a1';
const REC = '00000000-0000-4000-8000-0000000000b1';

describe('Phase 3 meeting transcript and report API', () => {
  let app: App;
  let repo: InMemoryMeetingInsights;
  beforeEach(async () => {
    repo = new InMemoryMeetingInsights();
    app = await buildApp({ meetingInsights: repo } as Partial<ModuleDeps>);
  });
  afterEach(async () => app.close());

  const createOrg = async (c: Client, name: string) =>
    (await c.post('/orgs', { name })).json<{ organization: { id: string } }>().organization.id;
  const tPath = (o: string, m = MEET) => `/orgs/${o}/meetings/${m}/transcript`;
  const rPath = (o: string, m = MEET) => `/orgs/${o}/meetings/${m}/report`;

  const transcript = (): Transcript => ({
    id: '00000000-0000-4000-8000-0000000000c1',
    meetingId: MEET,
    recordingId: REC,
    provider: 'assemblyai',
    language: 'en',
    segments: [
      {
        id: '00000000-0000-4000-8000-0000000000d1',
        index: 0,
        startMs: 0,
        endMs: 1500,
        speaker: 'A',
        text: 'hello',
        confidence: 0.9,
      },
    ],
    createdAt: '2026-10-26T00:00:00.000Z',
  });
  const report = (organizationId: string): Report => ({
    id: '00000000-0000-4000-8000-0000000000e1',
    organizationId,
    meetingId: MEET,
    summary: 'S',
    decisions: ['d'],
    risks: [],
    actionItems: [{ title: 'Ship', assigneeHint: 'Bob' }],
    aiRunId: null,
    createdAt: '2026-10-26T00:00:00.000Z',
  });

  it('returns 404 until the transcript and report exist, then the contract DTOs', async () => {
    const owner = await signupAndLogin(app, 'owner@example.com');
    const org = await createOrg(owner, 'Acme');
    expect((await owner.get(tPath(org))).statusCode).toBe(404);
    repo.addMeeting(org, MEET);
    const notReady = await owner.get(tPath(org));
    expect(notReady.statusCode).toBe(404);
    expect(Value.Check(ApiErrorEnvelope, notReady.json())).toBe(true);
    expect((await owner.get(rPath(org))).statusCode).toBe(404);

    repo.setTranscript(org, transcript());
    repo.setReport(report(org));
    const t = await owner.get(tPath(org));
    expect(t.statusCode).toBe(200);
    expect(Value.Check(Transcript, t.json())).toBe(true);
    const r = await owner.get(rPath(org));
    expect(r.statusCode).toBe(200);
    expect(Value.Check(Report, r.json())).toBe(true);
  });

  it("hides another organization's meeting (404) and requires a session (401)", async () => {
    const owner = await signupAndLogin(app, 'owner@example.com');
    const org = await createOrg(owner, 'Acme');
    repo.addMeeting(org, MEET);
    repo.setTranscript(org, transcript());
    const other = await signupAndLogin(app, 'other@example.com');
    await createOrg(other, 'Globex');
    expect((await other.get(tPath(org))).statusCode).toBe(404);
    expect((await other.get(rPath(org))).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: tPath(org) })).statusCode).toBe(401);
  });

  it('rejects malformed ids with 400', async () => {
    const owner = await signupAndLogin(app, 'owner@example.com');
    const org = await createOrg(owner, 'Acme');
    expect((await owner.get(tPath(org, 'not-a-uuid'))).statusCode).toBe(400);
  });

  it('refuses in-memory storage outside development/test', () => {
    expect(() => selectMeetingInsightsRepository({} as never, 'production')).toThrow(
      MissingProductionDependencyError,
    );
  });
});
