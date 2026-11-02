import { describe, expect, it } from 'vitest';
import { CONSENT_UPLOAD_PATHS } from '@meetops/contracts/types';
import { fillPath, uploadPaths } from '@/features/uploads/types';
import { MEETING_INSIGHTS_PATHS, insightsPath } from '@/features/meetings/insights-api';
import { RECORDING_PATHS } from '@/features/recording/session';
import { MEETING_CONSENT_PATHS as CONTRACT_MEETING_CONSENT_PATHS } from '@meetops/contracts';
import { MEETING_CONSENT_PATHS, meetingConsentPath } from '@/features/meetings/consent-api';

const ORG = '00000000-0000-4000-8000-000000000001';

describe('API route parity', () => {
  it('upload paths come from contracts CONSENT_UPLOAD_PATHS', () => {
    expect(uploadPaths.uploads(ORG)).toBe(`/orgs/${ORG}/uploads`);
    expect(uploadPaths.consentSettings(ORG)).toBe(`/orgs/${ORG}/settings/consent`);
    expect(uploadPaths.complete(ORG, 'a/b')).toBe(`/orgs/${ORG}/uploads/a%2Fb/complete`);
    expect(uploadPaths.downloadUrl(ORG, 'f')).toBe(
      fillPath(CONSENT_UPLOAD_PATHS.uploadDownloadUrl, { organizationId: ORG, fileObjectId: 'f' }),
    );
  });

  it('meeting consent paths match contracts MEETING_CONSENT_PATHS (#334)', () => {
    expect(MEETING_CONSENT_PATHS).toEqual(CONTRACT_MEETING_CONSENT_PATHS);
    expect(meetingConsentPath(MEETING_CONSENT_PATHS.revoke, ORG, 'm 1')).toBe(
      `/orgs/${ORG}/meetings/m%201/consent/revoke`,
    );
  });

  it('fillPath refuses a missing param', () => {
    expect(() => fillPath(CONSENT_UPLOAD_PATHS.uploadComplete, { organizationId: ORG })).toThrow(
      /fileObjectId/,
    );
  });

  it('insights paths match the API meeting-insights module (#212)', () => {
    expect(MEETING_INSIGHTS_PATHS).toEqual({
      transcript: '/orgs/:organizationId/meetings/:meetingId/transcript',
      report: '/orgs/:organizationId/meetings/:meetingId/report',
    });
    expect(insightsPath(MEETING_INSIGHTS_PATHS.report, ORG, 'm 1')).toBe(
      `/orgs/${ORG}/meetings/m%201/report`,
    );
  });

  it('recording paths match the API media module RECORDING_SESSION_PATHS (#197)', () => {
    expect(RECORDING_PATHS.init(ORG)).toBe(`/orgs/${ORG}/recording-sessions`);
    expect(RECORDING_PATHS.chunk('s')).toBe('/recording-sessions/s/chunks');
    expect(RECORDING_PATHS.complete('s')).toBe('/recording-sessions/s/complete');
    expect(RECORDING_PATHS.abort('s')).toBe('/recording-sessions/s/abort');
  });
});
