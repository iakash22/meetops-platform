import { CALENDAR_PATHS, CALENDAR_PROVIDERS } from '@meetops/contracts/types';
import type {
  CalendarEventList,
  CalendarProviderId,
  CalendarProviderList,
  ConnectCalendarResponse,
  Id,
} from '@meetops/contracts';
import type { ApiClient } from '@/lib/api/client';
import { fillPath } from '@/features/uploads/types';

export { CALENDAR_PATHS, CALENDAR_PROVIDERS };
export type { CalendarEventList, CalendarProviderList };
/** Where the OAuth callback sends the user back to. */
export const CALENDAR_RETURN_TO = '/calendar';

/** Server-known providers only: the web app never sends an endpoint or base URL. */
export interface CalendarApi {
  providers(organizationId: Id): Promise<CalendarProviderList>;
  connect(organizationId: Id, provider: CalendarProviderId): Promise<ConnectCalendarResponse>;
  disconnect(organizationId: Id, connectionId: Id): Promise<unknown>;
  events(organizationId: Id, from: string, to: string): Promise<CalendarEventList>;
}

export function createHttpCalendarApi(request: ApiClient['request']): CalendarApi {
  return {
    providers: (o) => request('GET', fillPath(CALENDAR_PATHS.providers, { organizationId: o })),
    connect: (o, provider) =>
      request('POST', fillPath(CALENDAR_PATHS.connect, { organizationId: o }), {
        provider,
        returnTo: CALENDAR_RETURN_TO,
      }),
    disconnect: (o, id) =>
      request(
        'DELETE',
        fillPath(CALENDAR_PATHS.connection, { organizationId: o, connectionId: id }),
      ),
    events: (o, from, to) =>
      request(
        'GET',
        `${fillPath(CALENDAR_PATHS.events, { organizationId: o })}?${new URLSearchParams({ from, to }).toString()}`,
      ),
  };
}

/** Monday 00:00 local time of the week containing `d`, shifted by `offset` weeks. */
export function weekWindow(d: Date, offset = 0): { from: Date; to: Date } {
  const from = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const dow = (from.getDay() + 6) % 7;
  from.setDate(from.getDate() - dow + offset * 7);
  const to = new Date(from);
  to.setDate(to.getDate() + 7);
  return { from, to };
}

/** Groups events by local calendar day (YYYY-MM-DD), preserving order. */
export function groupByDay<T extends { startsAt: string }>(items: readonly T[]): [string, T[]][] {
  const out = new Map<string, T[]>();
  for (const e of items) {
    const d = new Date(e.startsAt);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    out.set(key, [...(out.get(key) ?? []), e]);
  }
  return [...out];
}

let override: CalendarApi | null = null;
export function setCalendarApiOverride(api: CalendarApi | null): void {
  override = api;
}
export function getCalendarApi(request: ApiClient['request']): CalendarApi {
  return override ?? createHttpCalendarApi(request);
}
