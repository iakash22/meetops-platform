/** Local stand-ins for the CSP_*_ORIGIN values (API, realtime, storage and, in dev, the HMR socket). */
const LOCAL_ORIGINS = 'http://localhost:* ws://localhost:* http://127.0.0.1:* ws://127.0.0.1:*';

/**
 * P9 R24: the CSP the Vite dev and preview servers send, derived from the nginx template (the production source of
 * truth) so local runs hit the same violations. Report-to and upgrade-insecure-requests are dropped (plain http,
 * no endpoint). In dev, `nonce` is added to script-src/style-src for Vite's injected HMR client, React Refresh
 * preamble and CSS-in-JS `<style>` tags (`html.cspNonce` stamps it on them); there is no 'unsafe-inline'.
 */
export function localCsp(template: string, nonce?: string): string {
  const csp = /add_header Content-Security-Policy "([^"]+)" always;/.exec(template)?.[1];
  if (!csp) throw new Error('web.conf.template has no Content-Security-Policy');
  return csp
    .replace('$csp_upgrade_insecure', '')
    .replace('$csp_report_to', '')
    .replace('${CSP_API_ORIGIN} ${CSP_REALTIME_ORIGIN} ${CSP_STORAGE_ORIGIN}', LOCAL_ORIGINS)
    .replace('${CSP_STORAGE_ORIGIN}', 'http://localhost:* http://127.0.0.1:*')
    .split(';')
    .map((d) => d.trim())
    .filter(Boolean)
    .map((d) => (nonce && /^(script|style)-src /.test(d) ? `${d} 'nonce-${nonce}'` : d))
    .join('; ');
}
