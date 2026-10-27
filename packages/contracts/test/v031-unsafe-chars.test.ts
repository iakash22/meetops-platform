import { describe, it, expect } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import {
  CreateOrganizationRequest,
  ExtensionDeviceLabel,
  ExtensionPairResponse,
  SAFE_DISPLAY_TEXT_PATTERN,
  SAFE_DISPLAY_TEXT_TRIMMED_PATTERN,
} from '../src/index.js';

const id = '00000000-0000-4000-8000-000000000001';
const pair = {
  pairingCode: 'C'.repeat(43),
  expiresAt: '2026-10-22T08:00:00.000Z',
  organizationId: id,
  organizationName: 'Acme',
};

const cp = (n: number) => String.fromCodePoint(n);
const newChars: [string, number][] = [
  ['U+00AD soft hyphen', 0xad],
  ['U+180E Mongolian vowel separator', 0x180e],
  ['U+3164 Hangul filler', 0x3164],
  ...Array.from(
    { length: 16 },
    (_, i) =>
      [`U+FE0${i.toString(16).toUpperCase()} variation selector`, 0xfe00 + i] as [string, number],
  ),
  ...Array.from(
    { length: 0x80 },
    (_, i) =>
      [`U+E00${i.toString(16).toUpperCase().padStart(2, '0')} tag`, 0xe0000 + i] as [
        string,
        number,
      ],
  ),
];

// Ajv 8 (used by Fastify) compiles `pattern` as `new RegExp(pattern, 'u')`; TypeBox Value.Check compiles without a flag.
const uLabel = new RegExp(SAFE_DISPLAY_TEXT_PATTERN, 'u');
const uName = new RegExp(SAFE_DISPLAY_TEXT_TRIMMED_PATTERN, 'u');
const ajvLabel = (v: string) => uLabel.test(v);
const ajvName = (v: string) => uName.test(v);

describe('UNSAFE_DISPLAY_TEXT_CHARS additions', () => {
  it.each(newChars)('rejects %s in deviceLabel, org name and organizationName', (_label, code) => {
    const c = cp(code);
    for (const v of [`a${c}b`, c, `Acme${c}`]) {
      expect(Value.Check(ExtensionDeviceLabel, v)).toBe(false);
      expect(Value.Check(CreateOrganizationRequest, { name: v })).toBe(false);
      expect(Value.Check(ExtensionPairResponse, { ...pair, organizationName: v })).toBe(false);
      expect(new RegExp(SAFE_DISPLAY_TEXT_PATTERN, 'u').test(v)).toBe(false);
      expect(ajvLabel(v)).toBe(false);
      expect(ajvName(v)).toBe(false);
    }
  });
  it('still accepts normal text, accents, CJK, emoji and neighbours of the tag block', () => {
    for (const ok of [
      'Chrome on MacBook',
      'Büro PC',
      '東京オフィス',
      'Team 🚀',
      `a${cp(0xe0080)}b`,
      `a${cp(0xdffff)}b`,
      `a${cp(0xfe10)}b`,
    ]) {
      expect(Value.Check(ExtensionDeviceLabel, ok)).toBe(true);
      expect(Value.Check(CreateOrganizationRequest, { name: ok })).toBe(true);
      expect(ajvLabel(ok)).toBe(true);
      expect(ajvName(ok)).toBe(true);
    }
  });
  it('trimmed pattern behaves the same with and without the u flag', () => {
    for (const bad of ['   ', ' Acme', 'Acme ', '<img onerror=x>', 'a\u202Eb']) {
      expect(new RegExp(SAFE_DISPLAY_TEXT_TRIMMED_PATTERN).test(bad)).toBe(false);
      expect(ajvName(bad)).toBe(false);
    }
  });
});

describe('ExtensionPairResponse.organizationName', () => {
  it('uses SafeDisplayText with the org name bounds', () => {
    expect(Value.Check(ExtensionPairResponse, pair)).toBe(true);
    expect(Value.Check(ExtensionPairResponse, { ...pair, organizationName: 'x'.repeat(200) })).toBe(
      true,
    );
    for (const bad of [
      '',
      '   ',
      ' Acme',
      'x'.repeat(201),
      '<img onerror=x>',
      'Acme & Co',
      'a\u202Eb',
      "Akash's org",
    ]) {
      expect(Value.Check(ExtensionPairResponse, { ...pair, organizationName: bad })).toBe(false);
    }
  });
});
