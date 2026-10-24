/**
 * Single parser for credential references, shared by the config schema, the credential resolver and the router
 * org check (Security C1). A ref is either:
 *   - `env:NAME`               NAME matches ^[A-Z0-9_]+$
 *   - `secret:seg/seg/...`     every segment matches ^[A-Za-z0-9_-]+$
 * There is no decoding or normalization: '.', '..', empty segments ('//'), leading or trailing '/', '%', '\\' and any
 * other character are rejected outright, so `secret:org/A/../B/key` or `%2e%2e` can never address another org's path.
 */
export type ParsedCredentialRef =
  | { kind: 'env'; name: string }
  | { kind: 'secret'; segments: readonly string[]; path: string };

const ENV_NAME = /^[A-Z0-9_]+$/;
const SEGMENT = /^[A-Za-z0-9_-]+$/;
const MAX_REF_LENGTH = 512;

export function parseCredentialRef(ref: unknown): ParsedCredentialRef | null {
  if (typeof ref !== 'string' || ref.length === 0 || ref.length > MAX_REF_LENGTH) return null;
  if (ref.startsWith('env:')) {
    const name = ref.slice(4);
    return ENV_NAME.test(name) ? { kind: 'env', name } : null;
  }
  if (ref.startsWith('secret:')) {
    const path = ref.slice(7);
    const segments = path.split('/');
    // split() yields '' for leading/trailing/double slashes; SEGMENT rejects '', '.', '..', '%', '\\'.
    if (segments.length === 0 || !segments.every((s) => SEGMENT.test(s))) return null;
    return { kind: 'secret', segments, path: segments.join('/') };
  }
  return null;
}

/**
 * `secret:org/{organizationId}/<name>...` bound to exactly `organizationId` (exact first-segment comparison, at least one key segment).
 * Returns the parsed ref, or null if malformed or bound to another org.
 */
export function parseOrgSecretRef(ref: unknown, organizationId: string): Extract<ParsedCredentialRef, { kind: 'secret' }> | null {
  const p = parseCredentialRef(ref);
  if (!p || p.kind !== 'secret') return null;
  const [scope, owner, ...rest] = p.segments;
  if (scope !== 'org' || owner === undefined || owner !== organizationId || rest.length === 0) return null;
  return p;
}

/** Org-scoped shape only (no org binding): `secret:org/<id>/<name>...`. */
export function isOrgSecretRefShape(ref: unknown): boolean {
  const p = parseCredentialRef(ref);
  return p?.kind === 'secret' && p.segments[0] === 'org' && p.segments.length >= 3;
}
