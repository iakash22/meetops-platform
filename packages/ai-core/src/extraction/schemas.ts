import { z } from 'zod';

/** Versioned prompt ids. Bump on any prompt or schema change; stored on every result (promptVersion). */
export const EXTRACTION_PROMPT_VERSION = {
  map: 'meeting-map@1',
  reduce: 'meeting-reduce@1',
} as const;

const evidenceIds = z.array(z.string().min(1).max(64)).max(20);
const shortText = (max: number) => z.string().min(1).max(max);

/** Untrusted free text pointing at who might own a task. Never resolved to an identity in ai-core. */
export const assigneeHintSchema = z.string().max(120).nullable();

export const decisionSchema = z.object({ text: shortText(1000), evidenceSegmentIds: evidenceIds }).strict();

export const actionItemV1Schema = z
  .object({
    title: shortText(200),
    detail: z.string().max(2000),
    assigneeHint: assigneeHintSchema,
    dueHint: z.string().max(60).nullable(),
    evidenceSegmentIds: evidenceIds,
  })
  .strict();

/** What the model returns for one transcript window (map step). */
export const mapOutputSchema = z
  .object({
    summary: shortText(4000),
    decisions: z.array(decisionSchema).max(50),
    actionItems: z.array(actionItemV1Schema).max(50),
  })
  .strict();
export type MapOutput = z.infer<typeof mapOutputSchema>;

/** Reduce step: the model only rewrites the summary; lists are merged deterministically in code. */
export const reduceOutputSchema = z
  .object({ summary: shortText(8000), keyPoints: z.array(shortText(500)).max(20) })
  .strict();

export const evidenceRefSchema = z
  .object({ segmentId: z.string(), startSec: z.number().min(0), endSec: z.number().min(0) })
  .strict();

/** Draft task handed to Backend. status is ALWAYS 'draft' until an authorized human approves it elsewhere. */
export const draftTaskSchema = z
  .object({
    title: shortText(200),
    description: z.string().max(2000),
    status: z.literal('draft'),
    /** Untrusted text from the transcript. Display only; Backend may suggest org members, never auto-assign. */
    assigneeHint: assigneeHintSchema,
    dueHint: z.string().max(60).nullable(),
    evidence: z.array(evidenceRefSchema).max(20),
    flags: z.array(z.enum(['possible-injection', 'no-evidence'])).max(4),
  })
  .strict();
export type DraftTask = z.infer<typeof draftTaskSchema>;

export const meetingExtractionSchema = z
  .object({
    schemaVersion: z.literal(1),
    summary: shortText(8000),
    keyPoints: z.array(shortText(500)).max(20),
    decisions: z.array(z.object({ text: shortText(1000), evidence: z.array(evidenceRefSchema).max(20) }).strict()).max(100),
    actionItems: z.array(draftTaskSchema).max(100),
    draftTasks: z.array(draftTaskSchema).max(100),
    transcriptRevision: z.number().int().min(0),
    promptVersions: z.object({ map: z.string(), reduce: z.string() }).strict(),
    windows: z.number().int().min(1),
  })
  .strict();
export type MeetingExtraction = z.infer<typeof meetingExtractionSchema>;
