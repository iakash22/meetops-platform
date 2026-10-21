/**
 * Return `target` only if it is a same-origin relative path ("/foo?x#y"),
 * otherwise `fallback`. Rejects protocol-relative ("//"), absolute URLs,
 * backslashes, control characters and anything not starting with a single "/".
 */
export function safeRedirect(target: unknown, fallback = '/'): string {
  if (typeof target !== 'string' || target.length === 0) return fallback;
  if (!target.startsWith('/') || target.startsWith('//')) return fallback;
  if (target.includes('\\')) return fallback;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(target)) return fallback;
  try {
    const base = 'http://same-origin.invalid';
    const url = new URL(target, base);
    if (url.origin !== base) return fallback;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return fallback;
  }
}
