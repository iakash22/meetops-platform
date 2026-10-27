import { createHttpInsightsApi } from '../src/api/insightsApi';
import { fillPath, MEETING_INSIGHTS_PATHS, RECORDING_SESSION_ROUTES } from '../src/api/paths';
import { createHttpRecordingUploadApi } from '../src/upload/httpRecordingUploadApi';

const ORG = '00000000-0000-4000-8000-000000000001';

function fakeFetch(status: number, body: unknown) {
  const urls: string[] = [];
  const impl = ((url: string) => {
    urls.push(url);
    return Promise.resolve({
      status,
      text: () => Promise.resolve(JSON.stringify(body)),
    } as Response);
  }) as unknown as typeof fetch;
  return { impl, urls };
}

describe('API route parity', () => {
  it('recording-session routes match the API media module (#197/#206)', () => {
    expect(RECORDING_SESSION_ROUTES).toEqual({
      init: '/orgs/:organizationId/recording-sessions',
      chunks: '/recording-sessions/:sessionId/chunks',
      complete: '/recording-sessions/:sessionId/complete',
      abort: '/recording-sessions/:sessionId/abort',
    });
  });

  it('insights routes match the API meeting-insights module (#212)', () => {
    expect(MEETING_INSIGHTS_PATHS).toEqual({
      transcript: '/orgs/:organizationId/meetings/:meetingId/transcript',
      report: '/orgs/:organizationId/meetings/:meetingId/report',
    });
    expect(() => fillPath(MEETING_INSIGHTS_PATHS.report, { organizationId: ORG })).toThrow(
      /meetingId/,
    );
  });

  it('HTTP clients call the resolved paths', async () => {
    const rec = fakeFetch(201, { sessionId: 's' });
    await createHttpRecordingUploadApi({
      baseUrl: 'https://api.test/',
      getAccessToken: async () => 't',
      fetchImpl: rec.impl,
    }).init(ORG, {} as never);
    expect(rec.urls[0]).toBe(`https://api.test/orgs/${ORG}/recording-sessions`);
    const ins = fakeFetch(200, {});
    await createHttpInsightsApi({
      baseUrl: 'https://api.test',
      getAccessToken: async () => 't',
      fetchImpl: ins.impl,
    }).transcript(ORG, 'm 1');
    expect(ins.urls[0]).toBe(`https://api.test/orgs/${ORG}/meetings/m%201/transcript`);
  });
});
