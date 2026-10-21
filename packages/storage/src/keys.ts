import { StorageAccessError, StorageValidationError } from './errors.js';

const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const EXT = /^[a-z0-9]{1,8}$/;

export type MeetingObjectKind = 'recording' | 'normalized' | 'chunk' | 'session_chunk' | 'transcript' | 'export' | 'attachment';

/**
 * Server-side object reference. Callers pass IDs and a kind; the storage
 * package derives the key. Raw keys are never accepted from callers.
 */
export type MeetingObjectRef = {
  orgId: string;
  meetingId: string;
  kind: MeetingObjectKind;
  /** Id of the logical object (recording id, transcript id, ...). */
  objectId: string;
  /** File extension without dot. Ignored for `normalized` and `chunk` (always wav). */
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

export function orgPrefix(orgId: string): string {
  return `org/${id('orgId', orgId)}/`;
}

/** Derive the object key: org/{orgId}/meetings/{meetingId}/... */
export function buildObjectKey(ref: MeetingObjectRef): string {
  const base = `${orgPrefix(ref.orgId)}meetings/${id('meetingId', ref.meetingId)}`;
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
    case 'chunk':
      return `${base}/processed/${obj}/chunks/${idx(ref.index)}.wav`;
    case 'session_chunk':
      // objectId = recording session id; contracts caps seq at MAX_RECORDING_CHUNKS - 1 (99999).
      return `${base}/sessions/${obj}/chunks/${idx(ref.index)}.part`;
    case 'transcript':
    case 'export':
    case 'attachment':
      return `${base}/${ref.kind}s/${obj}.${ext()}`;
    default:
      throw new StorageValidationError('Invalid kind');
  }
}

export function parseMeetingKey(key: string): { orgId: string; meetingId: string; rest: string } | null {
  const m = /^org\/([^/]+)\/meetings\/([^/]+)\/(.+)$/.exec(key);
  if (!m || !ID.test(m[1]!) || !ID.test(m[2]!)) return null;
  return { orgId: m[1]!, meetingId: m[2]!, rest: m[3]! };
}

/** Throws StorageAccessError unless `key` lives under org/{orgId}/. Message never includes the key. */
export function assertKeyOwnedBy(key: string, orgId: string): void {
  if (typeof orgId !== 'string' || !ID.test(orgId)) throw new StorageAccessError('orgId is required');
  if (!key.startsWith(orgPrefix(orgId)) || key.includes('..') || key.includes('//') || key.includes('\\')) {
    throw new StorageAccessError();
  }
}
