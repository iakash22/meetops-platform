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
    const origin =
      typeof window !== 'undefined' && window.location?.origin && window.location.origin !== 'null'
        ? window.location.origin
        : BASE;
    const url = new URL(target, origin);
    if (url.origin !== origin) return fallback;
    // URL parsing normalises dot segments ("/.//evil.com" -> "//evil.com"), so
    // re-check the final path: it must not become protocol-relative or contain "\".
    if (/^[/\\][/\\]/.test(url.pathname)) return fallback;
    const result = `${url.pathname}${url.search}${url.hash}`;
    if (isUnsafe(result)) return fallback;
    // A re-resolution of the result must stay same-origin and stable.
    const again = new URL(result, origin);
    if (again.origin !== origin || `${again.pathname}${again.search}${again.hash}` !== result)
      return fallback;
    // Same check on the fully decoded form ("/.%2F/evil.com" decodes to "/.//evil.com"),
    // in case a router or history layer decodes the path before navigating.
    const decodedUrl = new URL(decoded, origin);
    if (decodedUrl.origin !== origin || /^[/\\][/\\]/.test(decodedUrl.pathname)) return fallback;
    return result;
  } catch {
    return fallback;
  }
}
