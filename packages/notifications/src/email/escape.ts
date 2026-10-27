/** Escape a value for HTML text or a double/single-quoted attribute. */
export function escapeHtml(value: unknown): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Only allow absolute http(s) links in templates to avoid javascript:/data: URLs. */
export function safeUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.protocol === 'http:' || u.protocol === 'https:') return u.toString();
  } catch {
    /* fallthrough */
  }
  throw new Error('Template URL must be an absolute http(s) URL');
}

/** Strip control characters (CR/LF etc.) so subjects can't inject headers. */
export function cleanSubject(subject: string): string {
  // eslint-disable-next-line no-control-regex
  return subject.replace(/[\r\n\u0000-\u001f\u007f]+/g, ' ').trim();
}
