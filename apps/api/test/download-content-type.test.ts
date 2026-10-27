import { describe, expect, it } from 'vitest';
import { downloadContentType } from '../src/modules/media/domain/ports.js';

describe('downloadContentType (security review B 4.1)', () => {
  it('keeps allowlisted base types and strips parameters', () => {
    expect(downloadContentType('audio/webm;codecs=opus')).toBe('audio/webm');
    expect(downloadContentType('video/mp4')).toBe('video/mp4');
  });
  it('maps everything else to application/octet-stream', () => {
    for (const t of ['', 'text/html', 'image/svg+xml', 'application/javascript', 'audio/webmx'])
      expect(downloadContentType(t)).toBe('application/octet-stream');
  });
});
