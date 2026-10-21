const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function assertSegment(name: string, value: string): void {
  if (!SEGMENT.test(value) || value === '.' || value === '..' || value.includes('..')) {
    throw new Error(`Invalid key segment for ${name}: "${value}"`);
  }
}

export function orgPrefix(orgId: string): string {
  assertSegment('orgId', orgId);
  return `org/${orgId}/`;
}

/** Builds `org/{orgId}/meetings/{meetingId}/{...parts}`. */
export function buildMeetingKey(orgId: string, meetingId: string, ...parts: string[]): string {
  assertSegment('meetingId', meetingId);
  parts.forEach((p, i) => assertSegment(`part[${i}]`, p));
  const base = `${orgPrefix(orgId)}meetings/${meetingId}`;
  return parts.length ? `${base}/${parts.join('/')}` : `${base}/`;
}

export function parseMeetingKey(key: string): { orgId: string; meetingId: string; rest: string } | null {
  const m = /^org\/([^/]+)\/meetings\/([^/]+)\/(.*)$/.exec(key);
  if (!m) return null;
  return { orgId: m[1]!, meetingId: m[2]!, rest: m[3]! };
}

/** Throws unless `key` lives under org/{orgId}/. */
export function assertKeyOwnedBy(key: string, orgId: string): void {
  if (!key.startsWith(orgPrefix(orgId)) || key.includes('..') || key.includes('//')) {
    throw new StorageAccessError(`Key is not owned by org ${orgId}`);
  }
}

export class StorageAccessError extends Error {
  override readonly name = 'StorageAccessError';
}
