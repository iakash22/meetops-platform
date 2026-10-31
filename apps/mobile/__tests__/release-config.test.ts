/* eslint-disable @typescript-eslint/no-require-imports */
import config, { MICROPHONE_PURPOSE } from '../app.config';

type Plugin = string | [string, unknown];
const plugins = (config.plugins ?? []) as Plugin[];
const names = plugins.map((p) => (Array.isArray(p) ? p[0] : p));

describe('release config (M6)', () => {
  it('keeps the placeholder ids until the owner decides', () => {
    expect(config.ios?.bundleIdentifier).toBe('com.example.meetops');
    expect(config.android?.package).toBe('com.example.meetops');
  });

  it('keeps audio out of backups and drops unused permissions (R4)', () => {
    expect(config.android?.allowBackup).toBe(false);
    expect(config.android?.blockedPermissions).toEqual(
      expect.arrayContaining([
        'android.permission.READ_EXTERNAL_STORAGE',
        'android.permission.WRITE_EXTERNAL_STORAGE',
        'android.permission.SYSTEM_ALERT_WINDOW',
      ]),
    );
  });

  it('uses the plan purpose string and the recording compliance plugin', () => {
    expect(MICROPHONE_PURPOSE).toMatch(/meeting audio you choose to capture/);
    expect(plugins).toContainEqual(['expo-audio', { microphonePermission: MICROPHONE_PURPOSE }]);
    expect(names).toContain('./plugins/withRecordingCompliance');
  });

  it('adds iOS background audio and never declares a foreground service it does not have (R2)', () => {
    const plugin = require('../plugins/withRecordingCompliance') as (c: object) => {
      mods?: { ios?: { infoPlist?: unknown } };
      android?: { permissions?: string[] };
    };
    const out = plugin({ name: 'x', slug: 'x', android: {} });
    expect(out.mods?.ios?.infoPlist).toBeDefined();
    expect(out.android?.permissions).toEqual(
      expect.arrayContaining([
        'android.permission.RECORD_AUDIO',
        'android.permission.POST_NOTIFICATIONS',
      ]),
    );
    expect(out.android?.permissions?.some((p) => p.includes('FOREGROUND_SERVICE'))).toBe(false);
  });

  it('defines dev-client, preview and production EAS profiles without secrets', () => {
    const eas = require('../eas.json') as {
      build: Record<string, { developmentClient?: boolean }>;
      submit: Record<string, unknown>;
    };
    expect(Object.keys(eas.build)).toEqual(['development', 'preview', 'production']);
    expect(eas.build.development?.developmentClient).toBe(true);
    expect(JSON.stringify(eas)).not.toMatch(/password|apiKey|secret|token/i);
    expect(require('../package.json').dependencies['expo-dev-client']).toBeDefined();
  });
});
