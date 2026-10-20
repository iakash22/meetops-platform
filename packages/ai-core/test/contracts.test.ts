import { describe, it, expect } from 'vitest';
import type { LLMProvider, TranscriptionProvider } from '../src';

describe('ai-core contracts', () => {
  it('types are defined', () => {
    const noop = (v: unknown) => v;
    // just ensure types can be referenced
    expect(typeof noop as unknown).toBe('function');
  });
});
