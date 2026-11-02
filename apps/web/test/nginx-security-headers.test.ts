import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const nginxDir = resolve(root, 'infra', 'docker', 'nginx');
const template = readFileSync(resolve(nginxDir, 'web.conf.template'), 'utf8');
const validator = resolve(nginxDir, '10-validate-csp-env.sh');

const GOOD = {
  CSP_API_ORIGIN: 'https://api.example.com',
  CSP_REALTIME_ORIGIN: 'wss://rt.example.com https://rt.example.com',
  CSP_STORAGE_ORIGIN: 'https://files.example.com',
};

function validate(env: Record<string, string | undefined>) {
  const clean: Record<string, string> = { PATH: process.env.PATH ?? '/usr/bin:/bin' };
  for (const [k, v] of Object.entries(env)) if (v !== undefined) clean[k] = v;
  return spawnSync('sh', [validator], { env: clean, encoding: 'utf8' });
}

/** Server-level `add_header <Name> <value> always;` lines from the template. */
function header(name: string): string | undefined {
  const re = new RegExp(`^ {4}add_header ${name} (.+) always;$`, 'm');
  const m = re.exec(template)?.[1];
  return m?.replace(/^"(.*)"$/, '$1');
}

describe('P9 R20: web container refuses weak CSP origins', () => {
  it('accepts valid origins, the compose defaults and an optional report URL', () => {
    expect(validate(GOOD).status).toBe(0);
    expect(
      validate({
        CSP_API_ORIGIN: 'http://localhost:3000',
        CSP_REALTIME_ORIGIN: 'ws://localhost:4001 http://localhost:4001',
        CSP_STORAGE_ORIGIN: 'http://localhost:9000',
        CSP_UPGRADE_INSECURE: 'off',
        CSP_REPORT_URL: '',
      }).status,
    ).toBe(0);
    expect(validate({ ...GOOD, CSP_REPORT_URL: 'https://api.example.com/csp' }).status).toBe(0);
  });

  it.each([
    ['unset', { CSP_API_ORIGIN: undefined }],
    ['empty', { CSP_STORAGE_ORIGIN: '' }],
    ['blank', { CSP_REALTIME_ORIGIN: '   ' }],
    ['bare *', { CSP_API_ORIGIN: '*' }],
    ['wildcard host', { CSP_STORAGE_ORIGIN: 'https://*.example.com' }],
    ['* among valid', { CSP_REALTIME_ORIGIN: 'wss://rt.example.com *' }],
    ['scheme-less', { CSP_API_ORIGIN: 'api.example.com' }],
    ['keyword injection', { CSP_API_ORIGIN: "https://a.example.com; script-src 'unsafe-inline'" }],
    ['path', { CSP_API_ORIGIN: 'https://api.example.com/v1' }],
    ['http report URL', { CSP_REPORT_URL: 'http://evil.example/csp' }],
    ['bad upgrade flag', { CSP_UPGRADE_INSECURE: 'maybe' }],
  ])('rejects %s', (_label, over) => {
    const res = validate({ ...GOOD, ...over });
    expect(res.status).not.toBe(0);
    expect(res.stderr).toMatch(/^10-validate-csp-env: /);
  });
});

describe('P9 R20-R23: nginx security headers', () => {
  it('CSP keeps the strict policy and adds upgrade-insecure-requests and report-to', () => {
    const csp = header('Content-Security-Policy')!;
    expect(csp).not.toMatch(/unsafe-inline|unsafe-eval/);
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none';$csp_upgrade_insecure report-to csp");
    expect(template).toMatch(/default " upgrade-insecure-requests;";/);
    expect(header('Reporting-Endpoints')).toBe('$csp_reporting_endpoints');
    expect(template).toContain('default "csp=\\"${CSP_REPORT_URL}\\"";');
  });

  it('sends HSTS, CORP and the rest of the baseline at server level', () => {
    expect(header('Strict-Transport-Security')).toBe('max-age=63072000; includeSubDomains');
    expect(header('Cross-Origin-Resource-Policy')).toBe('same-origin');
    expect(header('Cross-Origin-Opener-Policy')).toBe('same-origin');
    expect(header('X-Content-Type-Options')).toBe('nosniff');
    expect(header('X-Frame-Options')).toBe('DENY');
    expect(header('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
    expect(header('Permissions-Policy')).toBe(
      'camera=(), microphone=(self), geolocation=(), payment=(), usb=(), interest-cohort=()',
    );
  });

  it('R23: caching is a server-level map, never add_header/expires inside a location', () => {
    expect(header('Cache-Control')).toBe('$web_cache_control');
    expect(template).toContain('~^/assets/ "public, max-age=31536000, immutable";');
    expect(template).toMatch(/default\s+"no-store";/);
    for (const block of template.match(/location [^{]+\{[^}]*\}/g) ?? []) {
      expect(block).not.toMatch(/add_header|expires/);
    }
  });

  it('R25: index.html has no security-relevant <meta http-equiv>', () => {
    const html = readFileSync(resolve(root, 'apps', 'web', 'index.html'), 'utf8');
    expect(html).not.toMatch(/<meta[^>]+http-equiv/i);
  });
});

describe('P9 R20: inline content is hash-allowed, production origins are https', () => {
  it('index.html passes scripts/check-csp.mjs against the nginx template', async () => {
    const { checkCsp } = await import('../scripts/check-csp.mjs');
    const html = readFileSync(resolve(root, 'apps', 'web', 'index.html'), 'utf8');
    expect(checkCsp(html, template)).toEqual([]);
    expect(checkCsp(html.replace('</style>', ' </style>'), template)[0]).toMatch(/needs 'sha256-/);
    expect(checkCsp('<div style="x"></div>', template)).toContain(
      'style= attribute found (blocked by style-src)',
    );
  });

  it('rejects http:// and ws:// origins unless CSP_UPGRADE_INSECURE=off', () => {
    const local = {
      CSP_API_ORIGIN: 'http://localhost:3000',
      CSP_REALTIME_ORIGIN: 'ws://localhost:4001',
      CSP_STORAGE_ORIGIN: 'https://files.example.com',
    };
    const prod = validate(local);
    expect(prod.status).not.toBe(0);
    expect(prod.stderr).toMatch(/https:\/\/ or wss:\/\/ in production/);
    expect(validate({ ...local, CSP_UPGRADE_INSECURE: 'off' }).status).toBe(0);
  });
});

describe('P9 R24: Vite dev and preview CSP', () => {
  it('derives both from the nginx CSP, adding only a dev nonce and local origins', async () => {
    const { localCsp } = await import('../csp.config');
    const preview = localCsp(template);
    const dev = localCsp(template, 'n0nce');
    for (const csp of [preview, dev]) {
      expect(csp).not.toMatch(/unsafe-inline|unsafe-eval|\$\{|\$csp|report-to|upgrade-insecure/);
      expect(csp).toContain("frame-ancestors 'none'");
      expect(csp).toMatch(/connect-src 'self' http:\/\/localhost:\* ws:\/\/localhost:\*/);
    }
    expect(preview).not.toContain('nonce-');
    expect(dev).toMatch(/script-src 'self' 'nonce-n0nce'/);
    expect(dev).toMatch(/style-src 'self' 'sha256-[^']+' 'nonce-n0nce'/);
  });
});
