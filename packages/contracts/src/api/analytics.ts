import { Type, type Static } from '@sinclair/typebox';
import { Id, IsoDateTime } from '../common.js';
import { MeetingSource, MeetingStatus } from '../domain/meeting.js';
import { TaskStatus } from '../domain/task.js';

const strict = { additionalProperties: false } as const;

export { ANALYTICS_PATHS, MAX_ANALYTICS_RANGE_DAYS } from '../constants.js';

export const AnalyticsBucket = Type.Union([
  Type.Literal('day'),
  Type.Literal('week'),
  Type.Literal('month'),
]);
export type AnalyticsBucket = Static<typeof AnalyticsBucket>;

export const MeetingAnalyticsParams = Type.Object({ organizationId: Id }, strict);
export type MeetingAnalyticsParams = Static<typeof MeetingAnalyticsParams>;

/**
 * Half-open window `[from, to)` on the meeting's `createdAt`. `to` must be after `from` and the window at most
 * MAX_ANALYTICS_RANGE_DAYS (checked by the API: 400 VALIDATION_FAILED). Buckets are UTC (`date_trunc`); weeks start
 * on Monday. Default bucket: `day`.
 */
export const MeetingAnalyticsQuery = Type.Object(
  { from: IsoDateTime, to: IsoDateTime, bucket: Type.Optional(AnalyticsBucket) },
  strict,
);
export type MeetingAnalyticsQuery = Static<typeof MeetingAnalyticsQuery>;

const Count = Type.Integer({ minimum: 0 });

/** Aggregates only: no meeting ids, titles or people. Deleted meetings are excluded. */
export const MeetingAnalytics = Type.Object(
  {
    organizationId: Id,
    from: IsoDateTime,
    to: IsoDateTime,
    bucket: AnalyticsBucket,
    total: Count,
    bySource: Type.Array(Type.Object({ source: MeetingSource, count: Count }, strict), {
      maxItems: 16,
    }),
    byStatus: Type.Array(Type.Object({ status: MeetingStatus, count: Count }, strict), {
      maxItems: 16,
    }),
    /** Over meetings with a recorded `durationSec`; `averageSec` is null when none has one. */
    duration: Type.Object(
      {
        measured: Count,
        totalSec: Type.Integer({ minimum: 0 }),
        averageSec: Type.Union([Type.Number({ minimum: 0 }), Type.Null()]),
      },
      strict,
    ),
    /** Non-empty buckets only, ascending by `start`. */
    periods: Type.Array(Type.Object({ start: IsoDateTime, count: Count }, strict), {
      maxItems: 400,
    }),
  },
  strict,
);
export type MeetingAnalytics = Static<typeof MeetingAnalytics>;

/** Review state of an AI-extracted task (mirrors the database enum). */
export const ExtractedTaskReviewStatus = Type.Union([
  Type.Literal('pending_review'),
  Type.Literal('approved'),
  Type.Literal('rejected'),
  Type.Literal('converted'),
]);
export type ExtractedTaskReviewStatus = Static<typeof ExtractedTaskReviewStatus>;

/** Decision recorded on a task approval (mirrors the database enum). */
export const ApprovalDecisionValue = Type.Union([
  Type.Literal('approved'),
  Type.Literal('rejected'),
  Type.Literal('changes_requested'),
]);
export type ApprovalDecisionValue = Static<typeof ApprovalDecisionValue>;

export const TaskAnalyticsParams = MeetingAnalyticsParams;
export type TaskAnalyticsParams = Static<typeof TaskAnalyticsParams>;

/**
 * Half-open window `[from, to)` on each row's `createdAt` (tasks, extracted tasks, approvals). Same bounds as
 * MeetingAnalyticsQuery: `to > from`, at most MAX_ANALYTICS_RANGE_DAYS, else 400 VALIDATION_FAILED.
 */
export const TaskAnalyticsQuery = Type.Object({ from: IsoDateTime, to: IsoDateTime }, strict);
export type TaskAnalyticsQuery = Static<typeof TaskAnalyticsQuery>;

/**
 * Aggregates only: no ids, titles or people. Soft-deleted tasks and extracted tasks are excluded. Every list is
 * sorted alphabetically and only has non-zero entries.
 */
export const TaskAnalytics = Type.Object(
  {
    organizationId: Id,
    from: IsoDateTime,
    to: IsoDateTime,
    tasks: Type.Object(
      {
        total: Count,
        byStatus: Type.Array(Type.Object({ status: TaskStatus, count: Count }, strict), {
          maxItems: 16,
        }),
      },
      strict,
    ),
    extractedTasks: Type.Object(
      {
        total: Count,
        byStatus: Type.Array(
          Type.Object({ status: ExtractedTaskReviewStatus, count: Count }, strict),
          { maxItems: 16 },
        ),
      },
      strict,
    ),
    approvals: Type.Object(
      {
        total: Count,
        byDecision: Type.Array(
          Type.Object({ decision: ApprovalDecisionValue, count: Count }, strict),
          { maxItems: 16 },
        ),
      },
      strict,
    ),
  },
  strict,
);
export type TaskAnalytics = Static<typeof TaskAnalytics>;
