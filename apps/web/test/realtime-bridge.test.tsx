import { act, render } from '@testing-library/react';
import { QueryClient, QueryClientProvider, type InfiniteData } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Meeting, Paginated, Task } from '@meetops/contracts';
import { RealtimeBridge } from '@/lib/realtime/bridge';
import { useRealtimeStore } from '@/lib/realtime/store';
import { applyMeetingStatus, meetingPollInterval, queryKeys } from '@/lib/api/queries';
import { useOrgStore } from '@/stores/org-store';

const ORG = '00000000-0000-4000-8000-000000000001';
const OTHER = '00000000-0000-4000-8000-000000000009';
const MEETING = '20000000-0000-4000-8000-000000000001';
const TASK = '30000000-0000-4000-8000-000000000001';
const AT = '2026-11-03T10:00:00.000Z';

class Sock {
  static all: Sock[] = [];
  readyState = 1;
  sent: string[] = [];
  closed = false;
  onopen = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror = null;
  constructor(public url: string) {
    Sock.all.push(this);
  }
  send(d: string) {
    this.sent.push(d);
  }
  close() {
    this.closed = true;
  }
  recv(f: string) {
    act(() => this.onmessage?.({ data: f }));
  }
}
const factory = (u: string) => new Sock(u);

function setup(enabled = true) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData<Paginated<Task>>(queryKeys.tasks(ORG), {
    items: [{ id: TASK, status: 'todo', title: 'Old' } as unknown as Task],
    nextCursor: null,
  });
  qc.setQueryData<Meeting>(queryKeys.meeting(ORG, MEETING), {
    id: MEETING,
    status: 'processing',
  } as Meeting);
  qc.setQueryData<InfiniteData<Paginated<Meeting>>>(queryKeys.meetingsList(ORG), {
    pages: [{ items: [{ id: MEETING, status: 'processing' } as Meeting], nextCursor: null }],
    pageParams: [null],
  });
  const view = render(
    <QueryClientProvider client={qc}>
      <RealtimeBridge enabled={enabled} createSocket={factory} />
    </QueryClientProvider>,
  );
  return { qc, view };
}

beforeEach(() => {
  Sock.all = [];
  useOrgStore.setState({ currentOrganizationId: ORG });
});
afterEach(() => useOrgStore.getState().reset());

describe('RealtimeBridge', () => {
  it('does not connect when the flag is off', () => {
    setup(false);
    expect(Sock.all).toHaveLength(0);
    expect(useRealtimeStore.getState().status).toBe('idle');
  });

  it('routes task:update into applyTaskUpdate and meeting:status into the meeting caches', () => {
    const { qc } = setup();
    const ws = Sock.all[0]!;
    ws.recv('0{"sid":"a","pingInterval":25000,"pingTimeout":20000}');
    ws.recv('40{"sid":"b"}');
    expect(useRealtimeStore.getState().status).toBe('connected');

    ws.recv(
      `42["task:update",{"organizationId":"${ORG}","taskId":"${TASK}","status":"done","title":"New","at":"${AT}"}]`,
    );
    expect(qc.getQueryData<Paginated<Task>>(queryKeys.tasks(ORG))!.items[0]).toMatchObject({
      status: 'done',
      title: 'New',
    });

    ws.recv(
      `42["meeting:status",{"organizationId":"${ORG}","meetingId":"${MEETING}","status":"completed","at":"${AT}"}]`,
    );
    expect(qc.getQueryData<Meeting>(queryKeys.meeting(ORG, MEETING))!.status).toBe('completed');
    expect(
      qc.getQueryData<InfiniteData<Paginated<Meeting>>>(queryKeys.meetingsList(ORG))!.pages[0]!
        .items[0]!.status,
    ).toBe('completed');
  });

  it('drops events for another organization and invalid payloads', () => {
    const { qc } = setup();
    const ws = Sock.all[0]!;
    ws.recv('40');
    ws.recv(
      `42["task:update",{"organizationId":"${OTHER}","taskId":"${TASK}","status":"done","at":"${AT}"}]`,
    );
    ws.recv(
      `42["task:update",{"organizationId":"${ORG}","taskId":"${TASK}","status":"done","at":"${AT}","x":1}]`,
    );
    expect(qc.getQueryData<Paginated<Task>>(queryKeys.tasks(ORG))!.items[0]!.status).toBe('todo');
  });

  it('closes the socket and resets status on unmount', () => {
    const { view } = setup();
    Sock.all[0]!.recv('40');
    view.unmount();
    expect(Sock.all[0]!.closed).toBe(true);
    expect(useRealtimeStore.getState().status).toBe('idle');
  });
});

describe('polling fallback', () => {
  it('polls fast without realtime and slowly as a safety net with it', () => {
    expect(meetingPollInterval('processing')).toBe(5000);
    expect(meetingPollInterval('processing', true)).toBe(30000);
    expect(meetingPollInterval('completed', true)).toBe(false);
  });

  it('applyMeetingStatus rejects malformed events', () => {
    const qc = new QueryClient();
    expect(
      applyMeetingStatus(qc, { organizationId: ORG, meetingId: MEETING, status: 'bogus', at: AT }),
    ).toBe(false);
    expect(applyMeetingStatus(qc, null)).toBe(false);
  });
});
