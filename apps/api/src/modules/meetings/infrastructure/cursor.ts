import { InvalidMeetingCursorError } from '../domain/meeting.js';

/** Keyset cursor `m:<epoch ms>:<uuid>` (base64url) over (createdAt, id) descending. */
export interface MeetingCursorKey {
  createdAt: Date;
  id: string;
}

const CURSOR_RE = /^m:(\d{1,15}):([0-9a-f-]{36})$/;

export const encodeMeetingCursor = (k: MeetingCursorKey) =>
  Buffer.from(`m:${k.createdAt.getTime()}:${k.id}`, 'utf8').toString('base64url');

export function decodeMeetingCursor(cursor: string): MeetingCursorKey {
  const m = CURSOR_RE.exec(Buffer.from(cursor, 'base64url').toString('utf8'));
  if (!m?.[1] || !m[2]) throw new InvalidMeetingCursorError();
  return { createdAt: new Date(Number(m[1])), id: m[2] };
}

/** Descending order: newer first, ties broken by id descending. */
export const compareDesc = (a: MeetingCursorKey, b: MeetingCursorKey) =>
  b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
