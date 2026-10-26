import type { Id, Meeting } from '@meetops/contracts';
import type { ApiClient } from '@/lib/api/client';

/**
 * Meeting create/edit. DEPENDENCY: contracts 0.4.1 has no CreateMeetingRequest / UpdateMeetingRequest and the API has
 * no POST or PATCH /orgs/:organizationId/meetings yet (All Rounder, backend stream). These local types mirror the
 * `Meeting` DTO's editable fields; swap them for the contract types when they land.
 */
export type MeetingInput = {
  title: string;
  startedAt?: string;
  projectId?: Id;
};
export type MeetingPatch = Partial<MeetingInput>;

export const MEETING_MANAGE_PATHS = {
  create: (organizationId: Id) => `/orgs/${encodeURIComponent(organizationId)}/meetings`,
  update: (organizationId: Id, meetingId: Id) =>
    `/orgs/${encodeURIComponent(organizationId)}/meetings/${encodeURIComponent(meetingId)}`,
} as const;

export function createMeeting(api: ApiClient, organizationId: Id, body: MeetingInput) {
  return api.request<Meeting>('POST', MEETING_MANAGE_PATHS.create(organizationId), body);
}

export function updateMeeting(
  api: ApiClient,
  organizationId: Id,
  meetingId: Id,
  body: MeetingPatch,
) {
  return api.request<Meeting>(
    'PATCH',
    MEETING_MANAGE_PATHS.update(organizationId, meetingId),
    body,
  );
}

export type MeetingFilters = { q: string; status: Meeting['status'] | '' };

/** Client-side filter over the loaded page (the list route has no query params in 0.4.1). */
export function filterMeetings(items: readonly Meeting[], f: MeetingFilters): Meeting[] {
  const q = f.q.trim().toLowerCase();
  return items.filter(
    (m) => (!f.status || m.status === f.status) && (!q || m.title.toLowerCase().includes(q)),
  );
}

/** `datetime-local` value (local time) ⇄ ISO string. */
export function toLocalInput(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
export function fromLocalInput(v: string): string | undefined {
  if (!v) return undefined;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}
