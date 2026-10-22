import { describe, expect, it } from 'vitest';
import { resolveMeetingId } from '../src/lib/meeting.js';
import { UUID_RE } from '../src/lib/upload.js';

describe('resolveMeetingId (interim)', () => {
  it('returns a fresh UUID per recording', async () => {
    const a = await resolveMeetingId();
    const b = await resolveMeetingId();
    expect(a).toMatch(UUID_RE);
    expect(a).not.toBe(b);
  });
});
