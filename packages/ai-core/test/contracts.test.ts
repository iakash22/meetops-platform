import { describe, it, expect } from 'vitest';
import type { LLMProvider, TranscriptionProvider } from '../src';

describe('ai-core contracts', () => {
  it('types are defined', () => {
    // compile-time check that the provider contracts can be referenced
    type Contracts = [LLMProvider, TranscriptionProvider];
    const names: Array<keyof Contracts> = ['length'];
    expect(names).toHaveLength(1);
  });
});
