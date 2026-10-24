import { StorageAccessError, StorageValidationError } from './errors.js';

const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const EXT = /^[a-z0-9]{1,8}$/;

export type MeetingObjectKind = 'recording' | 'normalized' | 'chunk' | 'session_chunk' | 'transcript' | 'export' | 'attachment' | 'waveform';

/**
 * Server-side object reference. Callers pass IDs and a kind; the storage
 * package derives the key. Raw keys are never accepted from callers.
 */
export type MeetingObjectRef = MeetingObjectRefFields &
  (
    | { organizationId: string; /** @deprecated Use organizationId (ADR-010). */ orgId?: string }
    | {
        organizationId?: string;
        /** @deprecated Use organizationId (ADR-010). Accepted for one minor version. */
        orgId: string;
      }
  );

type MeetingObjectRefFields = {
  meetingId: string;
  kind: MeetingObjectKind;
  /** Id of the logical object (recording id, transcript id, ...). */
  objectId: string;
  /** File extension without dot. Ignored for `normalized` and `chunk` (always wav) and `waveform` (always json). */
  ext?: string;
  /** Required for kinds `chunk` and `session_chunk` (= recording-session `seq`): 0-based index. */
  index?: number;
};

/**
 * The organization id of a ref (ADR-010: organizationId, falling back to the deprecated orgId).
 * Throws if both are given and differ, so a ref can never point at two organizations.
 */
export function refOrganizationId(ref: { organizationId?: string; orgId?: string }): string {
  const { organizationId, orgId } = ref;
  if (organizationId !== undefined && orgId !== undefined && organizationId !== orgId) {
    throw new StorageValidationError('organizationId and orgId differ');
  }
  const v = organizationId ?? orgId;
  if (typeof v !== 'string') throw new StorageValidationError('Invalid organizationId');
  return v;
}

/**
 * Returns a copy of ref with both organizationId and the deprecated orgId set, so authorize hooks written
 * against either name keep working during the ADR-010 compatibility phase.
 */
export function normalizeMeetingObjectRef(ref: MeetingObjectRef): MeetingObjectRef & { organizationId: string; orgId: string } {
  const organizationId = refOrganizationId(ref);
  return { ...ref, organizationId, orgId: organizationId };
}

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

/** Current prefix. WRITERS (buildObjectKey) only ever emit this. */
export const ORGANIZATIONS_KEY_PREFIX = 'organizations/';
/**
 * Legacy prefix (org/{organizationId}/). READ-ONLY: accepted by parseMeetingKey/assertKeyOwnedBy and the stored-key
 * read methods until the staging copy to organizations/ is verified. Never produced by writers.
 */
export const LEGACY_ORG_KEY_PREFIX = 'org/';

export function organizationPrefix(organizationId: string): string {
  return `${ORGANIZATIONS_KEY_PREFIX}${id('organizationId', organizationId)}/`;
}

/** Legacy read-only prefix for an organization: org/{organizationId}/. */
export function legacyOrganizationPrefix(organizationId: string): string {
  return `${LEGACY_ORG_KEY_PREFIX}${id('organizationId', organizationId)}/`;
}

/** @deprecated Use organizationPrefix (ADR-010). Same output (organizations/{organizationId}/ since ADR-010 Phase A). */
export const orgPrefix = organizationPrefix;

/** Derive the object key: organizations/{organizationId}/meetings/{meetingId}/... */
export function buildObjectKey(ref: MeetingObjectRef): string {
  const base = `${organizationPrefix(refOrganizationId(ref))}meetings/${id('meetingId', ref.meetingId)}`;
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
    // Derived, untracked artifact: regenerated from the normalized WAV, no FileObject row, not in file_objects.
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

export type ParsedMeetingKey = {
  organizationId: string;
  /** @deprecated Use organizationId (ADR-010). */
  orgId: string;
  meetingId: string;
  rest: string;
  /** True for a legacy (read-only) org/ key. */
  legacy: boolean;
};

/** Parse a stored key under organizations/ or (legacy, read-only) org/. Unknown prefixes return null. */
export function parseMeetingKey(key: string): ParsedMeetingKey | null {
  if (typeof key !== 'string') return null;
  const k = key.startsWith(SESSION_CHUNK_PREFIX) ? key.slice(SESSION_CHUNK_PREFIX.length) : key;
  const m = /^(organizations|org)\/([^/]+)\/meetings\/([^/]+)\/(.+)$/.exec(k);
  if (!m || !ID.test(m[2]!) || !ID.test(m[3]!)) return null;
  return { organizationId: m[2]!, orgId: m[2]!, meetingId: m[3]!, rest: m[4]!, legacy: m[1] === 'org' };
}

/**
 * Throws StorageAccessError unless `key` lives under organizations/{organizationId}/ (or legacy, read-only,
 * org/{organizationId}/), optionally behind tmp/session-chunks/,
 * with a valid meetingId segment (and meetingId equal to `meetingId` when given). Never echoes the key.
 */
export function assertKeyOwnedBy(key: string, organizationId: string, meetingId?: string): void {
  if (typeof organizationId !== 'string' || !ID.test(organizationId)) throw new StorageAccessError('organizationId is required');
  if (typeof key !== 'string' || key.includes('..') || key.includes('//') || key.includes('\\')) throw new StorageAccessError();
  const isSession = key.startsWith(SESSION_CHUNK_PREFIX);
  const k = isSession ? key.slice(SESSION_CHUNK_PREFIX.length) : key;
  if (!k.startsWith(organizationPrefix(organizationId)) && !k.startsWith(legacyOrganizationPrefix(organizationId))) throw new StorageAccessError();
  const parsed = parseMeetingKey(key);
  if (!parsed || parsed.organizationId !== organizationId) throw new StorageAccessError();
  if (meetingId !== undefined && parsed.meetingId !== meetingId) throw new StorageAccessError();
  if (isSession && !/^sessions\/[A-Za-z0-9][A-Za-z0-9_-]{0,127}\/\d{5}\.part$/.test(parsed.rest)) throw new StorageAccessError();
}
