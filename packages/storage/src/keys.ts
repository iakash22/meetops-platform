import { StorageAccessError, StorageValidationError } from './errors.js';

const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const EXT = /^[a-z0-9]{1,8}$/;

export type MeetingObjectKind = 'recording' | 'normalized' | 'chunk' | 'session_chunk' | 'transcript' | 'export' | 'attachment' | 'waveform';

/**
 * Server-side object reference. Callers pass IDs and a kind; the storage
 * package derives the key. Raw keys are never accepted from callers.
 */
export type MeetingObjectRef = {
  organizationId: string;
  meetingId: string;
  kind: MeetingObjectKind;
  /** Id of the logical object (recording id, transcript id, ...). */
  objectId: string;
  /** File extension without dot. Ignored for `normalized` and `chunk` (always wav) and `waveform` (always json). */
  ext?: string;
  /** Required for kinds `chunk` and `session_chunk` (= recording-session `seq`): 0-based index. */
  index?: number;
};

function idx(i: number | undefined): string {
  if (i === undefined || !Number.isInteger(i) || i < 0 || i > 99999) throw new StorageValidationError('Invalid chunk index');
  return String(i).padStart(5, '0');
}

function id(name: string, v: string): string {
  if (typeof v !== 'string' || !ID.test(v)) throw new StorageValidationError(`Invalid ${name}`);
  return v;
}

/** Lifecycle-expirable prefix for recording-session chunks (configure e.g. 1-day expiry on it). */
export const SESSION_CHUNK_PREFIX = 'tmp/session-chunks/';

export function organizationPrefix(organizationId: string): string {
  return `organizations/${id('organizationId', organizationId)}/`;
}

/** Derive the object key: organizations/{organizationId}/meetings/{meetingId}/... */
export function buildObjectKey(ref: MeetingObjectRef): string {
  const base = `${organizationPrefix(ref.organizationId)}meetings/${id('meetingId', ref.meetingId)}`;
  const obj = id('objectId', ref.objectId);
  const ext = () => {
    const e = (ref.ext ?? '').toLowerCase();
    if (!EXT.test(e)) throw new StorageValidationError('Invalid ext');
    return e;
  };
  switch (ref.kind) {
    case 'recording':
      return `${base}/recordings/${obj}.${ext()}`;
    case 'normalized':
      return `${base}/processed/${obj}/normalized.wav`;
    case 'waveform':
      return `${base}/processed/${obj}/waveform.json`;
    case 'chunk':
      return `${base}/processed/${obj}/chunks/${idx(ref.index)}.wav`;
    case 'session_chunk':
      // Flat temp prefix so a prefix-only lifecycle rule (incl. R2) can expire abandoned chunks.
      // objectId = recording session id; contracts caps seq at MAX_CHUNKS - 1 (9999).
      return `${SESSION_CHUNK_PREFIX}${base}/sessions/${obj}/${idx(ref.index)}.part`;
    case 'transcript':
    case 'export':
    case 'attachment':
      return `${base}/${ref.kind}s/${obj}.${ext()}`;
    default:
      throw new StorageValidationError('Invalid kind');
  }
}

export function parseMeetingKey(key: string): { organizationId: string; meetingId: string; rest: string } | null {
  const k = key.startsWith(SESSION_CHUNK_PREFIX) ? key.slice(SESSION_CHUNK_PREFIX.length) : key;
  const m = /^organizations\/([^/]+)\/meetings\/([^/]+)\/(.+)$/.exec(k);
  if (!m || !ID.test(m[1]!) || !ID.test(m[2]!)) return null;
  return { organizationId: m[1]!, meetingId: m[2]!, rest: m[3]! };
}

/**
 * Throws StorageAccessError unless `key` lives under organizations/{organizationId}/ or tmp/session-chunks/organizations/{organizationId}/,
 * with a valid meetingId segment (and meetingId equal to `meetingId` when given). Never echoes the key.
 */
export function assertKeyOwnedBy(key: string, organizationId: string, meetingId?: string): void {
  if (typeof organizationId !== 'string' || !ID.test(organizationId)) throw new StorageAccessError('organizationId is required');
  if (typeof key !== 'string' || key.includes('..') || key.includes('//') || key.includes('\\')) throw new StorageAccessError();
  const isSession = key.startsWith(SESSION_CHUNK_PREFIX);
  const k = isSession ? key.slice(SESSION_CHUNK_PREFIX.length) : key;
  if (!k.startsWith(organizationPrefix(organizationId))) throw new StorageAccessError();
  const parsed = parseMeetingKey(key);
  if (!parsed || parsed.organizationId !== organizationId) throw new StorageAccessError();
  if (meetingId !== undefined && parsed.meetingId !== meetingId) throw new StorageAccessError();
  if (isSession && !/^sessions\/[A-Za-z0-9][A-Za-z0-9_-]{0,127}\/\d{5}\.part$/.test(parsed.rest)) throw new StorageAccessError();
}
