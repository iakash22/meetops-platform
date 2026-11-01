import type { Id, MeetingAnalytics } from '@meetops/contracts';
import { ANALYTICS_PATHS, MAX_ANALYTICS_RANGE_DAYS } from '@meetops/contracts/types';
import type { ApiClient } from '@/lib/api/client';

/** Read-only org meeting analytics (P7, PR #348 contract). */
export type AnalyticsBucket = MeetingAnalytics['bucket'];
export type AnalyticsQuery = { from: string; to: string; bucket?: AnalyticsBucket };

export type AnalyticsApi = {
  meetings: (organizationId: Id, query: AnalyticsQuery) => Promise<MeetingAnalytics>;
};

export function createAnalyticsApi(request: ApiClient['request']): AnalyticsApi {
  return {
    meetings: (organizationId, q) => {
      const p = new URLSearchParams({ from: q.from, to: q.to });
      if (q.bucket) p.set('bucket', q.bucket);
      const path = ANALYTICS_PATHS.meetings.replace(
        ':organizationId',
        encodeURIComponent(organizationId),
      );
      return request('GET', `${path}?${p.toString()}`);
    },
  };
}

export const RANGE_PRESETS = [
  { id: '7d', label: 'Last 7 days', days: 7, bucket: 'day' },
  { id: '30d', label: 'Last 30 days', days: 30, bucket: 'day' },
  { id: '90d', label: 'Last 90 days', days: 90, bucket: 'week' },
  { id: '365d', label: 'Last 12 months', days: 365, bucket: 'month' },
] as const satisfies ReadonlyArray<{
  id: string;
  label: string;
  days: number;
  bucket: AnalyticsBucket;
}>;
export type RangePresetId = (typeof RANGE_PRESETS)[number]['id'];

const DAY_MS = 86_400_000;

/**
 * Half-open `[from, to)` window ending at the start of tomorrow (UTC), so today is included and
 * the query key stays stable within a day. Clamped to the API's MAX_ANALYTICS_RANGE_DAYS.
 */
export function rangeFor(id: RangePresetId, now: Date = new Date()): AnalyticsQuery {
  const preset = RANGE_PRESETS.find((p) => p.id === id) ?? RANGE_PRESETS[1];
  const days = Math.min(preset.days, MAX_ANALYTICS_RANGE_DAYS);
  const to = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return {
    from: new Date(to - days * DAY_MS).toISOString(),
    to: new Date(to).toISOString(),
    bucket: preset.bucket,
  };
}

export function formatDuration(sec: number | null): string {
  if (sec === null) return '—';
  const s = Math.round(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

export const SOURCE_LABELS: Record<MeetingAnalytics['bySource'][number]['source'], string> = {
  upload: 'Upload',
  extension: 'Browser extension',
  desktop: 'Desktop app',
  bot: 'Meeting bot',
  mobile: 'Mobile app',
};
export const STATUS_LABELS: Record<MeetingAnalytics['byStatus'][number]['status'], string> = {
  scheduled: 'Scheduled',
  recording: 'Recording',
  processing: 'Processing',
  completed: 'Completed',
  failed: 'Failed',
};

/** Bucket start label, in UTC to match the API's buckets. */
export function periodLabel(start: string, bucket: AnalyticsBucket): string {
  const d = new Date(start);
  const opts: Intl.DateTimeFormatOptions =
    bucket === 'month'
      ? { month: 'short', year: 'numeric', timeZone: 'UTC' }
      : { month: 'short', day: 'numeric', timeZone: 'UTC' };
  return d.toLocaleDateString('en-US', opts);
}
