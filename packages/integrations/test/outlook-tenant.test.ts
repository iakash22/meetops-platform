import { describe, expect, it } from 'vitest';
import {
  OutlookCalendarProvider,
  OutlookTenantError,
  InMemoryOAuthStateStore,
  isValidOutlookTenant,
  parseOutlookTenant,
} from '../src/index.js';

const GUID = '72f988bf-86f1-41af-91ab-2d7cd011db47';

describe('parseOutlookTenant', () => {
  it('unset or blank means the provider default (common)', () => {
    expect(parseOutlookTenant(undefined)).toBeUndefined();
    expect(parseOutlookTenant('   ')).toBeUndefined();
  });

  it.each([
    'common',
    'organizations',
    'consumers',
    'Common',
    GUID,
    GUID.toUpperCase(),
    'contoso.onmicrosoft.com',
    'contoso.com',
    'sub.my-org.co.uk',
  ])('accepts %s', (t) => {
    expect(parseOutlookTenant(`  ${t} `)).toBe(t);
    expect(isValidOutlookTenant(t)).toBe(true);
  });

  it.each([
    'fabrikam',
    'common/../evil',
    'https://login.microsoftonline.com/common',
    'fabrikam.com/',
    'conto so.com',
    '-fabrikam.com',
    'fabrikam-.com',
    'fabrikam..com',
    'fabrikam.c0m',
    '72f988bf-86f1-41af-91ab-2d7cd011db4',
    'a'.repeat(64) + '.com',
    `${'a.'.repeat(126)}com`,
    'fabrikam.com?x=1',
    'xn--',
  ])('rejects %s with a clear error that never echoes the value', (t) => {
    let err: unknown;
    try {
      parseOutlookTenant(t);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(OutlookTenantError);
    expect((err as Error).message).toMatch(
      /^OUTLOOK_CALENDAR_TENANT must be common, organizations/,
    );
    expect((err as Error).message).not.toContain(t);
    expect(isValidOutlookTenant(t)).toBe(false);
  });

  it('the provider accepts a domain tenant in its authority URL', () => {
    const p = new OutlookCalendarProvider({
      clientId: 'id',
      clientSecret: async () => 'placeholder',
      tenant: 'contoso.onmicrosoft.com',
      redirectUriAllowlist: ['https://api.example.test/calendar/outlook/callback'],
      stateStore: new InMemoryOAuthStateStore(),
    });
    expect(p).toBeInstanceOf(OutlookCalendarProvider);
  });
});
