import { describe, expect, it } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import { CreateUploadRequest } from '../src/index.js';

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
