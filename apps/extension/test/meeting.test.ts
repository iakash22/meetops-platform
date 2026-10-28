import { describe, expect, it, vi } from 'vitest';
import { meetingValidators } from '../src/lib/auth/validate.js';
import {
  MEETINGS_RESOLVE_ROUTE,
  MeetingResolveError,
  createMeetingResolver,
  isResolveMeetingMessage,
  meetingUrlFromTab,
  resolveMeetingId,
} from '../src/lib/meeting.js';

const ORG = '7c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f';
const MID = '6f1c2b8e-3d4a-4e5f-9a6b-7c8d9e0f1a2b';
const fast = { sleep: async () => undefined, random: () => 0.5, now: () => 0 };
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function setup(...replies: (Response | Error)[]) {
  const calls: { path: string; init: RequestInit }[] = [];
  const api = vi.fn(async (path: string, init: RequestInit) => {
    calls.push({ path, init });
    const r = replies.shift() ?? json(200, { meetingId: MID, created: false });
    if (r instanceof Error) throw r;
    return r;
  });
  const resolve = createMeetingResolver({
    api,
    organizationId: async () => ORG,
    validators: meetingValidators,
    retry: fast,
  });
  return { resolve, calls, api };
}

describe('meetingUrlFromTab', () => {
  it('keeps only origin + path (no query, fragment or credentials)', () => {
    expect(meetingUrlFromTab('https://zoom.us/j/123?pwd=secret#x')).toBe('https://zoom.us/j/123');
    expect(meetingUrlFromTab('https://meet.google.com/abc-defg-hij?authuser=1')).toBe(
      'https://meet.google.com/abc-defg-hij',
    );
  });
  it('refuses non-https and odd pages', () => {
    for (const u of [
      undefined,
      '',
      'http://meet.example/x',
      'chrome://newtab',
      'https://u:p@x.test/',
      'nope',
    ])
      expect(meetingUrlFromTab(u)).toBeNull();
  });
});

describe('createMeetingResolver (POST /orgs/:org/meetings/resolve)', () => {
  it('posts a contract ResolveMeetingRequest to the org-scoped route and returns the meetingId', async () => {
    const { resolve, calls } = setup(json(201, { meetingId: MID, created: true }));
    expect(await resolve('https://meet.google.com/abc-defg-hij?authuser=1')).toBe(MID);
    expect(calls[0]!.path).toBe(MEETINGS_RESOLVE_ROUTE.replace(':organizationId', ORG));
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
      source: 'extension',
      externalMeetingUrl: 'https://meet.google.com/abc-defg-hij',
    });
  });

  it('is idempotent: the same meeting resolves to the same id', async () => {
    const { resolve } = setup(json(201, { meetingId: MID, created: true }));
    const a = await resolve('https://zoom.us/j/1?pwd=a');
    const b = await resolve('https://zoom.us/j/1?pwd=b');
    expect(a).toBe(b);
  });

  it('retries 5xx and network errors, then succeeds', async () => {
    const { resolve, api } = setup(json(503, {}), new TypeError('Failed to fetch'));
    expect(await resolve('https://meet.google.com/a')).toBe(MID);
    expect(api).toHaveBeenCalledTimes(3);
  });

  it('does not retry 4xx and reports only status + API code', async () => {
    const { resolve, api } = setup(
      json(403, { error: { code: 'FORBIDDEN', message: 'Bearer tok_secret', requestId: 'r' } }),
    );
    const err = await resolve('https://meet.google.com/a').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MeetingResolveError);
    expect((err as Error).message).toBe('Meeting resolve failed: HTTP 403 FORBIDDEN');
    expect((err as Error).message).not.toContain('tok_secret');
    expect(api).toHaveBeenCalledTimes(1);
  });

  it('rejects a response that fails contract validation', async () => {
    const { resolve } = setup(json(200, { meetingId: 'not-a-uuid', created: false }));
    await expect(resolve('https://meet.google.com/a')).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
    });
  });

  it('never calls the API for an unsupported page', async () => {
    const { resolve, api } = setup();
    await expect(resolve('chrome://extensions')).rejects.toMatchObject({
      code: 'UNSUPPORTED_PAGE',
    });
    expect(api).not.toHaveBeenCalled();
  });
});

describe('RESOLVE_MEETING message', () => {
  it('accepts only a well-formed request', () => {
    expect(
      isResolveMeetingMessage({ target: 'background', type: 'RESOLVE_MEETING', tabId: 3 }),
    ).toBe(true);
    expect(
      isResolveMeetingMessage({ target: 'background', type: 'RESOLVE_MEETING', tabId: -1 }),
    ).toBe(false);
    expect(isResolveMeetingMessage({ target: 'background', type: 'RESOLVE_MEETING' })).toBe(false);
  });

  it('popup side returns the id, and surfaces background errors', async () => {
    expect(await resolveMeetingId(3, async () => ({ ok: true, meetingId: MID }))).toBe(MID);
    await expect(
      resolveMeetingId(3, async () => ({ ok: false, error: 'not_paired' })),
    ).rejects.toThrow('not_paired');
    await expect(resolveMeetingId(3, async () => ({ ok: true, meetingId: 'x' }))).rejects.toThrow();
  });
});
