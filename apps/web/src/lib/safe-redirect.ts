const BASE = 'http://same-origin.invalid';
const MAX_DECODE_PASSES = 3;

function isUnsafe(path: string): boolean {
  if (!path.startsWith('/') || path.startsWith('//')) return true;
  if (path.includes('\\')) return true;
  // eslint-disable-next-line no-control-regex
  return /[\u0000-\u001f\u007f]/.test(path);
}

/**
 * Return `target` only if it is a same-origin relative path ("/foo?x#y"),
 * otherwise `fallback`. Rejects protocol-relative ("//"), absolute URLs,
 * backslashes and control characters, both as given and after percent-decoding
 * (so "/%2F%2Fevil" and "/%5Cevil" are rejected too).
 */
export function safeRedirect(target: unknown, fallback = '/'): string {
  if (typeof target !== 'string' || target.length === 0) return fallback;
  let decoded = target;
  for (let i = 0; i <= MAX_DECODE_PASSES; i++) {
    if (isUnsafe(decoded)) return fallback;
    let next: string;
    try {
      next = decodeURIComponent(decoded);
    } catch {
      return fallback;
    }
    if (next === decoded) break;
    if (i === MAX_DECODE_PASSES) return fallback; // still changing: suspicious nesting
    decoded = next;
  }
  try {
    const url = new URL(target, BASE);
    if (url.origin !== BASE) return fallback;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return fallback;
  }
}
