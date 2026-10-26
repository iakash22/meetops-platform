import { describe, it, expect } from 'vitest';
import type { EmailMessage } from '../src/index.js';

describe('contracts package', () => {
  it('should have a valid EmailMessage type example', () => {
    const msg: EmailMessage = {
      from: { email: 'bot@example.com', name: 'MeetOps AI' },
      to: [{ email: 'user@example.com' }],
      subject: 'Hello',
      text: 'World'
    };
    expect(msg.subject).toBe('Hello');
  });
});
