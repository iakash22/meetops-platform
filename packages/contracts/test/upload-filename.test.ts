import { describe, expect, it } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import { CreateUploadRequest, FILENAME_PATTERN, isSafeUploadFilename } from '../src/index.js';

const base = {
  mimeType: 'audio/webm',
  sizeBytes: 10,
  checksumSha256: 'LCa0a2j/xo/5m0U8HTBBNBNCLXBkg7+g+YpeiGJm564=',
};
const ok = (filename: string) => Value.Check(CreateUploadRequest, { ...base, filename });

describe('upload filename (security review B 4.3)', () => {
  it('accepts ordinary and unicode names', () => {
    for (const n of ['standup.webm', 'Réunion 2026-10-27 (final).mp4', '会議.webm', "o'brien.wav"])
      expect(ok(n), n).toBe(true);
  });
  it('rejects separators, control characters and bidi overrides', () => {
    for (const n of [
      'a/b.webm',
      'a\\b.webm',
      'a\u0000.webm',
      'a\r\nSet-Cookie: x.webm',
      'tab\there.webm',
      'del\u007f.webm',
      'evil\u202Egpj.exe',
      'iso\u2066late.webm',
      'esc\u001b[31m.webm',
    ])
      expect(ok(n), JSON.stringify(n)).toBe(false);
  });
});

describe('invisible / format characters (#270 L-1)', () => {
  const each = [
    ['U+200B zero width space', '\u200B'],
    ['U+200C ZWNJ', '\u200C'],
    ['U+200D ZWJ', '\u200D'],
    ['U+200E LRM', '\u200E'],
    ['U+200F RLM', '\u200F'],
    ['U+2060 word joiner', '\u2060'],
    ['U+2061 function application', '\u2061'],
    ['U+2062 invisible times', '\u2062'],
    ['U+2063 invisible separator', '\u2063'],
    ['U+2064 invisible plus', '\u2064'],
    ['U+FEFF BOM / ZWNBSP', '\uFEFF'],
    ['U+00AD soft hyphen', '\u00AD'],
    ['U+0085 NEL (C1)', '\u0085'],
    ['U+061C Arabic letter mark', '\u061C'],
    ['U+180E Mongolian vowel separator', '\u180E'],
    ['U+2028 line separator', '\u2028'],
    ['U+2029 paragraph separator', '\u2029'],
    ['U+206A inhibit symmetric swapping', '\u206A'],
    ['U+FFF9 interlinear annotation anchor', '\uFFF9'],
  ] as const;
  for (const [label, ch] of each) {
    it(`rejects ${label}`, () => {
      const n = `meet${ch}ing.webm`;
      expect(ok(n)).toBe(false);
      expect(new RegExp(FILENAME_PATTERN, 'u').test(n)).toBe(false); // Ajv (u flag) agrees
      expect(isSafeUploadFilename(n)).toBe(false);
    });
  }
  it('isSafeUploadFilename also rejects astral format characters (tags)', () => {
    const tag = 'a\u{E0041}.webm';
    expect(isSafeUploadFilename(tag)).toBe(false);
    expect(isSafeUploadFilename('会議 😀 notes.webm')).toBe(true);
    expect(isSafeUploadFilename('Réunion (final).mp4')).toBe(true);
  });
});
