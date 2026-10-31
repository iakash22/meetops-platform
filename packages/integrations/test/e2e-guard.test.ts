import { describe, expect, it } from 'vitest';
import { isThrowawayRepo, selectKeySource } from './e2e-guard';

describe('isThrowawayRepo', () => {
  it.each([
    'o/e2e',
    'o/e2e-foo',
    'o/foo-e2e',
    'o/throwaway-bar',
    'o/my_e2e',
    'o/sandbox.throwaway',
    'O/Foo-E2E',
  ])('accepts %s', (r) => expect(isThrowawayRepo(r)).toBe(true));
  it.each([
    'o/prod-e2e-svc',
    'o/prode2e',
    'o/e2etests',
    'o/my-throwaways',
    'o/meetops-platform',
    'e2e',
    'o/',
    '/e2e',
    'a/b/e2e',
  ])('rejects %s', (r) => expect(isThrowawayRepo(r)).toBe(false));
  it('accepts an explicitly allowlisted repo (case-insensitive, trimmed)', () => {
    expect(isThrowawayRepo('o/prod-e2e-svc', ' x/y , O/Prod-E2E-Svc ')).toBe(true);
    expect(isThrowawayRepo('o/prod-e2e-svc', 'o/other')).toBe(false);
  });
});

describe('selectKeySource', () => {
  it('uses the key file by default and ignores the inline env PEM', () => {
    expect(
      selectKeySource({ GITHUB_APP_PRIVATE_KEY_FILE: '/k.pem', GITHUB_APP_PRIVATE_KEY: 'x' }),
    ).toEqual({ kind: 'file', path: '/k.pem' });
    expect(selectKeySource({ GITHUB_APP_PRIVATE_KEY: 'x' })).toBeNull();
  });
  it('uses the inline env PEM only with MEETOPS_GITHUB_E2E_USE_ENV_KEY=1', () => {
    expect(
      selectKeySource({
        MEETOPS_GITHUB_E2E_USE_ENV_KEY: '1',
        GITHUB_APP_PRIVATE_KEY: 'x',
        GITHUB_APP_PRIVATE_KEY_FILE: '/k.pem',
      }),
    ).toEqual({ kind: 'env' });
    expect(selectKeySource({ MEETOPS_GITHUB_E2E_USE_ENV_KEY: '1' })).toBeNull();
  });
});
