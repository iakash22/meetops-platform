import { describe, expect, it } from 'vitest';
import { calendarSyncProvidersFromEnv } from '../src/calendar/scheduler.js';
import { CalendarSyncEnvError } from '../src/calendar/sync.js';
import {
  DEV_INTEGRATIONS_API_ORIGIN,
  IntegrationsApiOriginError,
  TokenRefreshEnvError,
  integrationsApiOrigin,
  isLocalNodeEnv,
  loadTokenRefreshEnv,
  tokenRefreshProvidersFromEnv,
} from '../src/integrations/index.js';

/**
 * #375 Tester L1: the INTEGRATIONS_API_ORIGIN guard used to treat only an exact NODE_ENV=production as prod, so
 * staging, `prod`, `Production` or an unset NODE_ENV silently built http://localhost:4000 OAuth redirect URIs. It
 * now fails closed: only NODE_ENV exactly `development` or `test` gets the local default.
 */
const NOT_LOCAL: (string | undefined)[] = [
  undefined,
  '',
  ' ',
  'production',
  'Production',
  'PRODUCTION',
  'prod',
  'staging',
  'stage',
  'preview',
  'qa',
  ' production ',
  'Development',
  'TEST',
  ' development',
  'test ',
  'dev',
  'local',
];

const withNodeEnv = (nodeEnv: string | undefined, rest: NodeJS.ProcessEnv = {}) =>
  (nodeEnv === undefined ? { ...rest } : { ...rest, NODE_ENV: nodeEnv }) as NodeJS.ProcessEnv;

describe('INTEGRATIONS_API_ORIGIN fails closed outside development/test (#375 L1)', () => {
  it('isLocalNodeEnv is true only for exactly development or test', () => {
    expect(isLocalNodeEnv('development')).toBe(true);
    expect(isLocalNodeEnv('test')).toBe(true);
    for (const v of NOT_LOCAL) expect(isLocalNodeEnv(v), String(v)).toBe(false);
  });

  it.each(NOT_LOCAL.map((v) => [JSON.stringify(v ?? null), v] as const))(
    'NODE_ENV=%s: unset origin throws (no localhost default)',
    (_label, nodeEnv) => {
      expect(() => integrationsApiOrigin(withNodeEnv(nodeEnv))).toThrow(IntegrationsApiOriginError);
      expect(() => integrationsApiOrigin(withNodeEnv(nodeEnv))).toThrow(
        /INTEGRATIONS_API_ORIGIN is required/,
      );
    },
  );

  it.each(NOT_LOCAL.map((v) => [JSON.stringify(v ?? null), v] as const))(
    'NODE_ENV=%s: http or localhost http origins are refused; a bare https origin is accepted',
    (_label, nodeEnv) => {
      for (const bad of ['http://localhost:4000', 'http://api.example.com', 'https://a.example/x'])
        expect(() =>
          integrationsApiOrigin(withNodeEnv(nodeEnv, { INTEGRATIONS_API_ORIGIN: bad })),
        ).toThrow(IntegrationsApiOriginError);
      expect(
        integrationsApiOrigin(
          withNodeEnv(nodeEnv, { INTEGRATIONS_API_ORIGIN: 'https://api.example.com/' }),
        ),
      ).toBe('https://api.example.com');
    },
  );

  it('development and test keep the local default and allow http', () => {
    for (const nodeEnv of ['development', 'test']) {
      expect(integrationsApiOrigin({ NODE_ENV: nodeEnv })).toBe(DEV_INTEGRATIONS_API_ORIGIN);
      expect(
        integrationsApiOrigin({
          NODE_ENV: nodeEnv,
          INTEGRATIONS_API_ORIGIN: 'http://localhost:4100',
        }),
      ).toBe('http://localhost:4100');
    }
  });

  it.each(['staging', 'prod', 'Production', undefined])(
    'NODE_ENV=%s: the worker refuses to start Jira refresh / Google calendar sync without the origin',
    (nodeEnv) => {
      const jira = withNodeEnv(nodeEnv, { JIRA_CLIENT_ID: 'id', JIRA_CLIENT_SECRET: 's' });
      expect(() => tokenRefreshProvidersFromEnv(jira)).toThrow(TokenRefreshEnvError);
      expect(() =>
        loadTokenRefreshEnv({ ...jira, INTEGRATIONS_TOKEN_REFRESH_ENABLED: 'true' }),
      ).toThrow(TokenRefreshEnvError);
      const google = withNodeEnv(nodeEnv, {
        GOOGLE_CALENDAR_CLIENT_ID: 'id',
        GOOGLE_CALENDAR_CLIENT_SECRET: 's',
      });
      expect(() => calendarSyncProvidersFromEnv(google)).toThrow(CalendarSyncEnvError);
      expect(
        calendarSyncProvidersFromEnv({
          ...google,
          INTEGRATIONS_API_ORIGIN: 'https://api.example.com',
        }).google,
      ).toBeDefined();
    },
  );
});
