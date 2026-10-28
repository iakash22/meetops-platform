import { describe, expect, it } from 'vitest';
import { CONSENT_UPLOAD_PATHS, EXTENSION_AUTH_PATHS } from '@meetops/contracts/types';
import { fillPath, RECORDING_SESSION_ROUTES } from '../src/lib/api-paths';
import { DIRECT_UPLOAD_PATHS } from '../src/lib/upload-direct';
import { RECORDING_SESSION_PATHS } from '../src/lib/upload-http';
import { MEETINGS_RESOLVE_ROUTE } from '../src/lib/meeting';
// The API's own constant (meetings/resolve is not in contracts MEETING_PATHS yet).
import { readFileSync } from 'node:fs';

const ORG = '00000000-0000-4000-8000-000000000001';

describe('API route parity', () => {
  it('extension auth routes are the contracts EXTENSION_AUTH_PATHS (#209/#200)', () => {
    expect(EXTENSION_AUTH_PATHS).toMatchObject({
      token: '/auth/extension-token',
      refresh: '/auth/extension/refresh',
      revoke: '/auth/extension/revoke',
    });
  });

  it('direct upload paths come from CONSENT_UPLOAD_PATHS (#196)', () => {
    expect(DIRECT_UPLOAD_PATHS.init(ORG)).toBe(
      fillPath(CONSENT_UPLOAD_PATHS.uploads, { organizationId: ORG }),
    );
    expect(DIRECT_UPLOAD_PATHS.complete(ORG, 'a/b')).toBe(`/orgs/${ORG}/uploads/a%2Fb/complete`);
  });

  it('recording-session routes match the API media module (#197/#206)', () => {
    expect(RECORDING_SESSION_ROUTES).toEqual({
      init: '/orgs/:organizationId/recording-sessions',
      chunks: '/recording-sessions/:sessionId/chunks',
      complete: '/recording-sessions/:sessionId/complete',
      abort: '/recording-sessions/:sessionId/abort',
    });
    expect(RECORDING_SESSION_PATHS.init(ORG)).toBe(`/orgs/${ORG}/recording-sessions`);
    expect(RECORDING_SESSION_PATHS.chunks('s 1')).toBe('/recording-sessions/s%201/chunks');
  });

  it('meetings/resolve route matches the API (bearer-cors MEETINGS_RESOLVE_PATH)', () => {
    const api = readFileSync(
      new URL('../../api/src/modules/extension-auth/http/bearer-cors.ts', import.meta.url),
      'utf8',
    );
    expect(api).toContain(`MEETINGS_RESOLVE_PATH = '${MEETINGS_RESOLVE_ROUTE}'`);
  });

  it('fillPath refuses a missing param', () => {
    expect(() => fillPath(CONSENT_UPLOAD_PATHS.uploadComplete, { organizationId: ORG })).toThrow(
      /fileObjectId/,
    );
  });
});
