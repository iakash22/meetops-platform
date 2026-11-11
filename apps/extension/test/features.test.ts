import { describe, expect, it, vi } from 'vitest';
import { flagDisabled, flagEnabled, httpUploadEnabled } from '../src/lib/features.js';
import { selectUploadClient } from '../src/lib/upload-select.js';
import { StubUploadClient, type UploadClient } from '../src/lib/upload.js';

describe('flagEnabled / flagDisabled', () => {
  it('only true / 1 turn a flag on, and only false / 0 turn it off explicitly', () => {
    for (const v of ['true', 'TRUE', ' 1 ', '1', true]) expect(flagEnabled(v)).toBe(true);
    for (const v of [undefined, '', 'false', '0', 'yes', 'on', false, 1])
      expect(flagEnabled(v)).toBe(false);
    for (const v of ['false', 'FALSE', ' 0 ', '0', false]) expect(flagDisabled(v)).toBe(true);
    for (const v of [undefined, '', 'true', '1', 'off', 'no', true, 0])
      expect(flagDisabled(v)).toBe(false);
  });
});

describe('WXT_FEATURE_HTTP_UPLOAD resolution', () => {
  it('is on by default in development builds, and off in production', () => {
    expect(httpUploadEnabled({ MODE: 'development' })).toBe(true);
    expect(httpUploadEnabled({ DEV: true })).toBe(true);
    expect(httpUploadEnabled({ MODE: 'production' })).toBe(false);
    expect(httpUploadEnabled({ DEV: false, MODE: 'production' })).toBe(false);
    expect(httpUploadEnabled({})).toBe(false);
  });

  it('stays off in the test runner so tests use the stub', () => {
    expect(httpUploadEnabled()).toBe(false);
    expect(httpUploadEnabled({ MODE: 'test', DEV: true, VITEST: true })).toBe(false);
    expect(httpUploadEnabled({ NODE_ENV: 'test', DEV: true })).toBe(false);
    // Test wins over a bare DEV=true when MODE=test.
    expect(httpUploadEnabled({ MODE: 'test', DEV: true })).toBe(false);
  });

  it('honours an explicit flag in every mode', () => {
    for (const env of [
      { MODE: 'development' },
      { MODE: 'production' },
      { MODE: 'test', VITEST: true },
    ] as const) {
      expect(httpUploadEnabled({ ...env, WXT_FEATURE_HTTP_UPLOAD: 'true' })).toBe(true);
      expect(httpUploadEnabled({ ...env, WXT_FEATURE_HTTP_UPLOAD: '1' })).toBe(true);
      expect(httpUploadEnabled({ ...env, WXT_FEATURE_HTTP_UPLOAD: 'false' })).toBe(false);
      expect(httpUploadEnabled({ ...env, WXT_FEATURE_HTTP_UPLOAD: '0' })).toBe(false);
    }
    // Unrecognised values stay off, even in development.
    expect(httpUploadEnabled({ MODE: 'development', WXT_FEATURE_HTTP_UPLOAD: 'yes' })).toBe(false);
  });

  it('selects the stub unless enabled, and only builds the HTTP client when enabled', () => {
    const make = vi.fn<() => UploadClient>(() => new StubUploadClient());
    expect(selectUploadClient(false, make)).toBeInstanceOf(StubUploadClient);
    expect(make).not.toHaveBeenCalled();
    const real = {} as UploadClient;
    make.mockReturnValueOnce(real);
    expect(selectUploadClient(true, make)).toBe(real);
  });
});
