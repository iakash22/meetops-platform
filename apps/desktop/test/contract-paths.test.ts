import { describe, expect, it, vi } from 'vitest';
import { createNativeInsightsApi } from '@/features/meetings/native-insights-api';
import { createNativeUploadApi } from '@/features/recording/native-upload-api';
import { fillPath, MEETING_INSIGHTS_PATHS, RECORDING_SESSION_ROUTES } from '@/lib/api-paths';

const ORG = '00000000-0000-4000-8000-000000000001';

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
  });

  it('fillPath encodes values and refuses a missing param', () => {
    expect(fillPath(RECORDING_SESSION_ROUTES.chunks, { sessionId: 'a/b' })).toBe(
      '/recording-sessions/a%2Fb/chunks',
    );
    expect(() => fillPath(MEETING_INSIGHTS_PATHS.report, { organizationId: ORG })).toThrow(
      /meetingId/,
    );
  });

  it('native clients send the resolved paths to Rust', async () => {
    const invoke = vi.fn().mockResolvedValue({});
    await createNativeUploadApi(invoke).init(ORG, {} as never);
    await createNativeInsightsApi(invoke).report(ORG, 'm 1');
    expect(invoke).toHaveBeenNthCalledWith(1, 'api_request', {
      method: 'POST',
      path: `/orgs/${ORG}/recording-sessions`,
      body: {},
    });
    expect(invoke).toHaveBeenNthCalledWith(2, 'api_request', {
      method: 'GET',
      path: `/orgs/${ORG}/meetings/m%201/report`,
    });
  });
});
