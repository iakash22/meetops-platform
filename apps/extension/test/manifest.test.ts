import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { manifest } from '../src/manifest.js';

const EXPECTED = ['activeTab', 'alarms', 'offscreen', 'storage', 'tabCapture'];

describe('manifest permissions', () => {
  it('requests only activeTab, alarms, tabCapture, offscreen, storage and no host permissions', () => {
    expect([...manifest.permissions].sort()).toEqual(EXPECTED);
    expect(manifest.host_permissions).toEqual([]);
  });

  it('externally_connectable lists only the exact production web origin (ADR-005 A1.1.5)', () => {
    expect(manifest.externally_connectable.matches).toEqual(['https://app.meetops.ai/*']);
    expect(JSON.stringify(manifest)).not.toMatch(/localhost|127\.0\.0\.1|http:\/\//);
  });

  const built = resolve(__dirname, '../dist/chrome-mv3/manifest.json');
  it.runIf(existsSync(built))('built manifest stays minimal', () => {
    const m = JSON.parse(readFileSync(built, 'utf8'));
    expect(m.manifest_version).toBe(3);
    expect([...(m.permissions ?? [])].sort()).toEqual(EXPECTED);
    expect(m.host_permissions ?? []).toEqual([]);
    expect(m.content_scripts).toBeUndefined();
    expect(m.optional_permissions).toBeUndefined();
    expect(m.externally_connectable).toEqual({ matches: ['https://app.meetops.ai/*'] });
  });
});
