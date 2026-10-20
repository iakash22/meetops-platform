import { describe, it, expect } from 'vitest';

describe('web app smoke', () => {
  it('passes basic truthy test', () => {
    expect('MeetOps AI'.includes('MeetOps')).toBe(true);
  });
});
