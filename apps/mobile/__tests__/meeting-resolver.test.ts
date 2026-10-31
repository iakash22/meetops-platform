import {
  createDemoMeetingResolver,
  createHttpMeetingResolver,
} from '../src/consent/meetingResolver';

describe('meeting resolver (Low: server meeting id)', () => {
  it('posts a contracts ResolveMeetingRequest and returns the server id', async () => {
    const request = jest.fn(() => Promise.resolve({ meetingId: 'm-1', created: true }));
    const id = await createHttpMeetingResolver(request as never).resolve(
      'org 1',
      '2026-10-31T10:00:00.000Z',
    );
    expect(id).toBe('m-1');
    expect(request).toHaveBeenCalledWith(
      'POST',
      '/orgs/org%201/meetings/resolve',
      expect.objectContaining({
        source: 'upload',
        startedAt: '2026-10-31T10:00:00.000Z',
        externalMeetingId: expect.stringMatching(/^mobile:[A-Za-z0-9_.:@/-]+$/),
      }),
    );
  });

  it('demo ids are UUID-shaped', async () => {
    await expect(createDemoMeetingResolver().resolve('o', 't')).resolves.toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
});
