/**
 * ADR-021 MFA security suite (plan: docs/12-security/mfa-test-plan.md, cases MFA-*).
 *
 * MFA is decided (ADR-021) but NOT built. This file has two parts:
 *
 * 1. ACTIVE checks that pass on today's code: the session `auth_level` column and its default, that no sign-in path
 *    (password or Google) elevates a session, the inventory of routes ADR-021 says need step-up, CSRF on those routes,
 *    and log redaction of TOTP material. Some of them are deliberate "pins": they fail on purpose when MFA routes or
 *    `authLevel` writes land, which is the signal to un-skip part 2.
 *
 * 2. PENDING cases, flagged `TODO(ADR-021)`, written against the PROPOSED interface in `PLANNED` below. They are
 *    `describe.skip` (concrete code) or `it.todo` (not automatable yet), so they never fail the suite before MFA lands.
 *    When All Rounder Techy ships MFA: align `PLANNED` with the real paths/fields/error codes (one place), flip
 *    `describe.skip` to `describe`, and turn the todos into tests. Cases blocked by a known finding say so
 *    (`N-4`, `P-1`, ...; see the plan's findings section).
 *
 * No real secrets: the TOTP secret below is the RFC 6238 test vector key, and every token is generated at run time.
 */
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DEFAULT_REDACT_KEYS, CENSOR, redactDeep, redactUrl } from '@meetops/logger';
import type { DatabaseClient } from '../src/shared/prisma/context.js';
import type { GoogleOAuthClient } from '../src/modules/auth/application/google-oauth.js';
import type { GoogleIdentity } from '../src/modules/auth/application/google-oidc.js';
import { InMemorySessionRepository } from '../src/modules/auth/infrastructure/in-memory-session.repository.js';
import { PrismaSessionRepository } from '../src/modules/auth/infrastructure/prisma/prisma-session.repository.js';
import {
  SESSION_AUTH_LEVELS,
  toSessionAuthLevel,
  type Session,
} from '../src/modules/auth/domain/session.js';
import { InMemoryAuditLog } from '../src/modules/auth/domain/audit.js';
import { InMemoryUserRepository } from '../src/modules/users/infrastructure/in-memory-user.repository.js';
import {
  buildApp,
  Client,
  CSRF as CSRF_COOKIE,
  ORIGIN,
  PASSWORD,
  SID,
  signupAndLogin,
  type App,
} from './helpers.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..');
const API_SRC = join(HERE, '..', 'src');

/* ------------------------------------------------------------------------------------------------------------------
 * PROPOSED interface (TODO(ADR-021)). ADR-021 names the factors and the step-up rule but not the HTTP shape; these
 * names are the plan's proposal. Change them HERE when the real routes land.
 * ---------------------------------------------------------------------------------------------------------------- */
const PLANNED = {
  paths: {
    status: '/auth/mfa',
    totpEnroll: '/auth/mfa/totp/enroll',
    totpConfirm: '/auth/mfa/totp/confirm',
    /** Second step of login for a user with MFA (session stays non-elevated until this succeeds). */
    challenge: '/auth/mfa/challenge',
    stepUp: '/auth/mfa/step-up',
    recoveryCodes: '/auth/mfa/recovery-codes',
    factor: (id: string) => `/auth/mfa/factors/${id}`,
    webauthnRegisterOptions: '/auth/mfa/webauthn/register/options',
    webauthnRegisterVerify: '/auth/mfa/webauthn/register/verify',
    webauthnAuthOptions: '/auth/mfa/webauthn/authenticate/options',
    webauthnAuthVerify: '/auth/mfa/webauthn/authenticate/verify',
  },
  /** Body field for a TOTP code. NOT `code`: the logger treats a 6-digit `code` as an error code (finding P-1). */
  totpField: 'totpCode',
  recoveryField: 'recoveryCode',
  errors: {
    mfaRequired: 'MFA_REQUIRED',
    stepUpRequired: 'STEP_UP_REQUIRED',
    invalidCode: 'INVALID_MFA_CODE',
  },
  levels: { password: 'password', mfa: 'mfa' },
  audit: {
    enrolled: 'auth.mfa.enroll',
    confirmed: 'auth.mfa.confirm',
    disabled: 'auth.mfa.disable',
    challengeSuccess: 'auth.mfa.challenge.success',
    challengeFailure: 'auth.mfa.challenge.failure',
    stepUp: 'auth.mfa.step_up',
    recoveryUsed: 'auth.mfa.recovery_code.used',
    recoveryRegenerated: 'auth.mfa.recovery_codes.regenerate',
    lockout: 'auth.mfa.lockout',
  },
} as const;

/** ADR-021 Decision 4: step-up for billing, retention, integrations and role changes, mapped to today's routes. */
const STEP_UP_ROUTES = [
  { category: 'role changes', method: 'PATCH', url: '/orgs/:organizationId/members/:userId' },
  { category: 'integrations', method: 'POST', url: '/orgs/:organizationId/integrations/connect' },
  {
    category: 'integrations',
    method: 'DELETE',
    url: '/orgs/:organizationId/integrations/:integrationId',
  },
] as const;
/** Contracted (CONSENT_UPLOAD_PATHS.consentSettings) but not served by the API yet; billing (ADR-017) has no route. */
const STEP_UP_NOT_BUILT = [
  { category: 'retention', method: 'PATCH', url: '/orgs/:organizationId/settings/consent' },
] as const;

/** API source files allowed to reference the elevated session level (grows only with reviewed MFA code). */
const MFA_LEVEL_ALLOWLIST = [
  'modules/auth/domain/session.ts',
  'modules/auth/infrastructure/prisma/prisma-session.repository.ts',
] as const;

/* ---------------------------------------------- RFC 6238 helpers ---------------------------------------------- */
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32Decode(s: string): Buffer {
  const clean = s.replace(/=+$/, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const i = B32.indexOf(ch);
    if (i < 0) throw new Error('bad base32');
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}
/** HOTP/TOTP (RFC 4226/6238), SHA-1, 6 digits, 30 s unless told otherwise. */
export function totp(secretB32: string, atMs: number, stepS = 30, digits = 6): string {
  const counter = Math.floor(atMs / 1000 / stepS);
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = createHmac('sha1', base32Decode(secretB32)).update(msg).digest();
  const off = h[h.length - 1]! & 0x0f;
  const bin = ((h[off]! & 0x7f) << 24) | (h[off + 1]! << 16) | (h[off + 2]! << 8) | h[off + 3]!;
  return String(bin % 10 ** digits).padStart(digits, '0');
}
const secretFromUri = (uri: string) => new URL(uri).searchParams.get('secret') ?? '';
function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
/** RFC 6238 Appendix B test key ("12345678901234567890"), built at run time so no secret-looking literal is committed. */
const RFC_KEY = base32Encode(Buffer.from('12345678901234567890', 'ascii'));
/** A short made-up marker used to check that values are redacted. */
const MARKER = RFC_KEY.slice(0, 16);

/* ---------------------------------------------- shared helpers ---------------------------------------------- */
function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}
const errCode = (r: { json: () => unknown }) =>
  (r.json() as { error?: { code?: string } }).error?.code;
const sidOf = (c: Client) => c.jar.get(SID);

const GOOGLE_CONFIG = {
  clientId: '1234567890-abc.apps.googleusercontent.com',
  clientSecret: 'test-secret-value',
  redirectUri: 'http://localhost:5173/api/auth/google/callback',
};
function fakeGoogle(identity: GoogleIdentity): GoogleOAuthClient {
  return {
    exchangeCode: async () => 'fake-id-token',
    verifyIdToken: async () => identity,
  };
}
async function googleSignIn(app: App): Promise<Client> {
  const start = await app.inject({ method: 'GET', url: '/auth/google/start' });
  const state = new URL(String(start.headers.location)).searchParams.get('state') ?? '';
  const cookie = start.cookies.find((c) => c.name.endsWith('meetops_oauth'));
  if (!cookie) throw new Error('missing oauth cookie');
  const q = new URLSearchParams({ code: 'good-code', state, scope: 'openid email profile' });
  const done = await app.inject({
    method: 'GET',
    url: `/auth/google/callback?${q.toString()}`,
    headers: { cookie: `${cookie.name}=${cookie.value}` },
  });
  const c = new Client(app);
  c.absorb(done);
  if (!sidOf(c)) throw new Error(`google sign-in failed: ${String(done.headers.location)}`);
  return c;
}
const authLevelOf = (s: Session) => (s as Session & { authLevel?: string }).authLevel;

/* ================================================================================================================
 * PART 1 — ACTIVE (passes on current code)
 * ============================================================================================================== */

describe('ADR-021 baseline: session auth_level (active)', () => {
  it('MFA-SES-01: sessions.auth_level exists, is NOT NULL and defaults to "password" (schema + migration)', () => {
    const schema = readFileSync(join(REPO, 'packages/database/prisma/schema.prisma'), 'utf8');
    const model = schema.slice(schema.indexOf('model Session {'));
    expect(model.slice(0, model.indexOf('\n}'))).toMatch(
      /authLevel\s+String\s+@default\("password"\)\s+@map\("auth_level"\)/,
    );
    const migrations = join(REPO, 'packages/database/prisma/migrations');
    const sql = readdirSync(migrations)
      .map((d) => join(migrations, d, 'migration.sql'))
      .filter((p) => {
        try {
          return statSync(p).isFile();
        } catch {
          return false;
        }
      })
      .map((p) => readFileSync(p, 'utf8'))
      .join('\n');
    expect(sql).toMatch(/"auth_level" TEXT NOT NULL DEFAULT 'password'/);
  });

  it('MFA-SES-02: the Prisma session repository writes "password" for a session without a level, and mfaAt only on an "mfa" session', async () => {
    const writes: Record<string, unknown>[] = [];
    const fakeDb = {
      session: {
        create: async ({ data }: { data: Record<string, unknown> }) => {
          writes.push(data);
          return {
            ...data,
            revokedAt: null,
            geoCity: null,
            geoRegion: null,
            geoCountry: null,
            geoCountryCode: null,
            geoApproximate: null,
          };
        },
      },
    } as unknown as DatabaseClient;
    const repo = new PrismaSessionRepository(fakeDb);
    const now = new Date('2026-11-09T00:00:00.000Z');
    const base: Session = {
      id: '00000000-0000-4000-8000-000000000001',
      userId: '00000000-0000-4000-8000-000000000002',
      tokenHash: 'h',
      activeOrganizationId: null,
      createdAt: now,
      lastSeenAt: now,
      expiresAt: new Date(now.getTime() + 3_600_000),
      revokedAt: null,
      ip: null,
      userAgent: null,
    };
    await repo.create(base);
    expect(writes).toHaveLength(1);
    // N-4 (OIDC hardening) made the level explicit; a session without one is never elevated.
    expect(writes[0]!.authLevel).toBe(PLANNED.levels.password);
    expect(writes[0]!.mfaAt).toBeNull();
    // ADR-021: a step-up time without the mfa level is dropped (the DB CHECK sessions_mfa_at_level_check agrees).
    const stray = await repo.create({
      ...base,
      id: '00000000-0000-4000-8000-000000000003',
      mfaAt: now,
    });
    expect(writes[1]!.mfaAt).toBeNull();
    expect(stray.mfaAt).toBeNull();
    const elevated = await repo.create({
      ...base,
      id: '00000000-0000-4000-8000-000000000004',
      authLevel: PLANNED.levels.mfa,
      mfaAt: now,
    });
    expect(writes[2]!.authLevel).toBe(PLANNED.levels.mfa);
    expect(elevated.mfaAt?.getTime()).toBe(now.getTime());
    // Unknown stored levels are not trusted; "mfa" is now a real level.
    expect(toSessionAuthLevel('superuser')).toBe(PLANNED.levels.password);
    expect(toSessionAuthLevel(PLANNED.levels.mfa)).toBe(PLANNED.levels.mfa);
    expect(SESSION_AUTH_LEVELS).toContain(PLANNED.levels.mfa);
  });

  it('MFA-SES-03: a password login does not create an elevated session', async () => {
    const sessions = new InMemorySessionRepository();
    const app = await buildApp({ sessions });
    await signupAndLogin(app, 'pw-only@example.com');
    const created = [...sessions.items.values()];
    expect(created.length).toBeGreaterThan(0);
    for (const s of created) expect(authLevelOf(s)).not.toBe(PLANNED.levels.mfa);
    await app.close();
  });

  it('MFA-OIDC-01/02: a Google sign-in is not elevated and records its own auth_level "google" (N-4)', async () => {
    const sessions = new InMemorySessionRepository();
    const app = await buildApp({
      sessions,
      users: new InMemoryUserRepository(),
      googleOAuth: {
        config: GOOGLE_CONFIG,
        client: fakeGoogle({
          sub: '100000000000000000001',
          email: 'g-user@gmail.com',
          emailVerified: true,
          name: 'G User',
        }),
      },
    });
    const c = await googleSignIn(app);
    expect((await c.get('/auth/session')).statusCode).toBe(200);
    const created = [...sessions.items.values()];
    expect(created).toHaveLength(1);
    // Not elevated today, and N-4: distinguishable from a password session.
    expect(authLevelOf(created[0]!)).not.toBe(PLANNED.levels.mfa);
    expect(authLevelOf(created[0]!)).toBe('google');
    await app.close();
  });
});

describe('ADR-021 baseline: step-up route inventory (active)', () => {
  it('MFA-SU-01: every route ADR-021 Decision 4 maps to today is registered (step-up must be added to each)', async () => {
    const app = await buildApp();
    for (const r of STEP_UP_ROUTES) {
      expect(
        app.hasRoute({ method: r.method, url: r.url }),
        `${r.category}: ${r.method} ${r.url}`,
      ).toBe(true);
    }
    await app.close();
  });

  it('MFA-SU-02 (pin): retention and billing writes are not served yet; when one lands it must join STEP_UP_ROUTES', async () => {
    const app = await buildApp();
    for (const r of STEP_UP_NOT_BUILT) {
      expect(
        app.hasRoute({ method: r.method, url: r.url }),
        `${r.category}: ${r.method} ${r.url}`,
      ).toBe(false);
    }
    const billing = app.printRoutes({ commonPrefix: false });
    expect(billing).not.toMatch(/billing/i);
    await app.close();
  });

  it('MFA-CSRF-01: the step-up routes already refuse a state change without a CSRF token (403)', async () => {
    const app = await buildApp();
    const c = await signupAndLogin(app, 'csrf-owner@example.com');
    const org = (await c.post('/orgs', { name: 'CSRF Org' })).json<{
      organization: { id: string };
    }>().organization.id;
    const fill = (u: string) =>
      u
        .replace(':organizationId', org)
        .replace(':userId', '00000000-0000-4000-8000-000000000009')
        .replace(':integrationId', '00000000-0000-4000-8000-000000000008');
    for (const r of STEP_UP_ROUTES) {
      const res = await app.inject({
        method: r.method,
        url: fill(r.url),
        ...(r.method === 'DELETE' ? {} : { payload: { role: 'admin', provider: 'jira' } }),
        headers: { cookie: c.cookie, origin: ORIGIN },
      });
      expect(res.statusCode, `${r.method} ${r.url}`).toBe(403);
      expect(errCode(res)).toBe('CSRF_INVALID');
      // Positive control: with the token the same request gets past CSRF (404/503 for the made-up ids).
      const ok = await c.send(
        r.method,
        fill(r.url),
        r.method === 'DELETE' ? undefined : { role: 'admin', provider: 'jira' },
      );
      expect(errCode(ok)).not.toBe('CSRF_INVALID');
    }
    await app.close();
  });
});

describe('ADR-021 build state (active pins: when one fails, un-skip the matching TODO(ADR-021) suite below)', () => {
  it('pieces (b) + (c): status, enrol, confirm, the login challenge, step-up, regenerate and factor removal are served', async () => {
    const app = await buildApp();
    expect(app.hasRoute({ method: 'GET', url: PLANNED.paths.status })).toBe(true);
    for (const p of [PLANNED.paths.totpEnroll, PLANNED.paths.totpConfirm, PLANNED.paths.challenge])
      expect(app.hasRoute({ method: 'POST', url: p }), p).toBe(true);
    // MFA-CSRF-02: enrolment and the challenge are never a GET.
    for (const p of [PLANNED.paths.totpEnroll, PLANNED.paths.totpConfirm, PLANNED.paths.challenge])
      expect(app.hasRoute({ method: 'GET', url: p }), p).toBe(false);
    for (const p of [PLANNED.paths.stepUp, PLANNED.paths.recoveryCodes])
      expect(app.hasRoute({ method: 'POST', url: p }), p).toBe(true);
    expect(app.hasRoute({ method: 'DELETE', url: '/auth/mfa/factors/:factorId' })).toBe(true);
    await app.close();
  });

  it('only the allowlisted MFA files reference the "mfa" session level (nothing else can elevate a session)', () => {
    // N-4 legitimately writes "password" / "google". ADR-021 piece (a) adds the level to the domain and its storage
    // mapping only; later pieces add the elevation path (AuthService.elevate) and the gates to this list, nothing else.
    const setsMfa =
      /(?:authLevel|auth_level)['"]?\s*(?:[:=]|===?|!==?)\s*['"`]mfa['"`]|['"`]mfa['"`]\s*(?:===?|!==?)\s*\w*[aA]uth_?[lL]evel|SESSION_AUTH_LEVELS\s*=\s*\[[^\]]*['"`]mfa['"`]/;
    for (const sample of ["authLevel: 'mfa'", 'session.authLevel = "mfa"', "auth_level === 'mfa'"])
      expect(setsMfa.test(sample), sample).toBe(true);
    expect(setsMfa.test("authLevel: 'google'")).toBe(false);
    const offenders = walk(API_SRC)
      .filter((f) => setsMfa.test(readFileSync(f, 'utf8')))
      .map((f) => f.slice(API_SRC.length + 1).replaceAll('\\', '/'))
      .sort();
    expect(offenders).toEqual([...MFA_LEVEL_ALLOWLIST].sort());
  });
});

describe('ADR-021 baseline: TOTP material in logs (active)', () => {
  it('MFA-SEC-03: a TOTP shared secret under a `secret` key is redacted at any depth', () => {
    const out = JSON.stringify(
      redactDeep({ body: { factor: { secret: RFC_KEY } } }, DEFAULT_REDACT_KEYS),
    );
    expect(out).not.toContain(MARKER);
    expect(out).toContain(CENSOR);
  });

  it('MFA-SEC-04: an otpauth:// URI logged as a URL loses its secret', () => {
    const uri = `otpauth://totp/MeetOps:ada%40example.com?secret=${RFC_KEY}&issuer=MeetOps`;
    const out = redactUrl(uri);
    expect(out).not.toContain(MARKER);
    expect(out).toContain('issuer=MeetOps');
    expect(JSON.stringify(redactDeep({ url: uri }, DEFAULT_REDACT_KEYS))).not.toContain(MARKER);
  });

  it('self-check: the test TOTP helper matches the RFC 6238 SHA-1 vectors', () => {
    // RFC 6238 Appendix B key "12345678901234567890" (base32 below), 8 digits.
    const key = RFC_KEY;
    expect(totp(key, 59_000, 30, 8)).toBe('94287082');
    expect(totp(key, 1_111_111_109_000, 30, 8)).toBe('07081804');
    expect(totp(key, 20_000_000_000_000, 30, 8)).toBe('65353130');
  });
});

/* ================================================================================================================
 * PART 2 — PENDING, TODO(ADR-021). Proposed interface: PLANNED above.
 * ============================================================================================================== */

describe('ADR-021 log redaction of MFA fields (P-1 / P-4 fixed in @meetops/logger)', () => {
  // P-1: CONDITIONAL_REDACT_KEYS treats a `code` that looks like /^\d{1,6}$/ as an error code and keeps it.
  it('MFA-SEC-05 (P-1): a 6-digit TOTP sent as `code` is redacted', () => {
    expect(
      JSON.stringify(redactDeep({ body: { code: '492039' } }, DEFAULT_REDACT_KEYS)),
    ).not.toContain('492039');
  });
  // P-4: DEFAULT_REDACT_KEYS has no MFA field names.
  it('MFA-SEC-06 (P-4): MFA field names are always redacted', () => {
    const body = {
      totpCode: '492039',
      recoveryCode: 'abcd-efgh-ijkl',
      recoveryCodes: ['abcd-efgh-ijkl', 'mnop-qrst-uvwx'],
      totpSecret: MARKER,
      otpauthUri: `otpauth://totp/x?secret=${MARKER}`,
    };
    const out = JSON.stringify(redactDeep({ body }, DEFAULT_REDACT_KEYS));
    for (const v of ['492039', 'abcd-efgh-ijkl', 'mnop-qrst-uvwx', MARKER]) {
      expect(out).not.toContain(v);
    }
  });
});

/** Enroll + confirm TOTP for a signed-in client. Proposed shapes; see PLANNED. */
async function enrollTotp(c: Client) {
  const e = await c.post(PLANNED.paths.totpEnroll, {});
  expect(e.statusCode).toBe(201);
  const { factorId, otpauthUri } = e.json<{ factorId: string; otpauthUri: string }>();
  const secret = secretFromUri(otpauthUri);
  // Confirm with the previous step (inside the ±1 window, OQ-2), so a test's next code for "now" is not a replay of the
  // confirm code (the replay guard only accepts steps after the last one used).
  const ok = await c.post(PLANNED.paths.totpConfirm, {
    factorId,
    [PLANNED.totpField]: totp(secret, Date.now() - 30_000),
  });
  expect(ok.statusCode).toBe(200);
  const { recoveryCodes } = ok.json<{ recoveryCodes: string[] }>();
  return { factorId, otpauthUri, secret, recoveryCodes };
}
async function sessionLevel(c: Client) {
  return (await c.get('/auth/session')).json<{ session?: { authLevel?: string } }>().session
    ?.authLevel;
}

describe('ADR-021 enrollment (MFA-ENR)', () => {
  it('MFA-ENR-01/02: enroll returns an otpauth URI with a >=160-bit base32 secret, issuer and account label', async () => {
    const app = await buildApp();
    const c = await signupAndLogin(app, 'enr1@example.com');
    const e = await c.post(PLANNED.paths.totpEnroll, {});
    expect(e.statusCode).toBe(201);
    const uri = new URL(e.json<{ otpauthUri: string }>().otpauthUri);
    expect(uri.protocol).toBe('otpauth:');
    expect(uri.host).toBe('totp');
    expect(base32Decode(uri.searchParams.get('secret') ?? '').length).toBeGreaterThanOrEqual(20);
    expect(uri.searchParams.get('issuer')).toBeTruthy();
    expect(decodeURIComponent(uri.pathname)).toContain('enr1@example.com');
    expect(e.headers['cache-control']).toMatch(/no-store/);
    await app.close();
  });

  it('MFA-ENR-03: two enrollments never share a secret', async () => {
    const app = await buildApp();
    const a = await signupAndLogin(app, 'enr3a@example.com');
    const b = await signupAndLogin(app, 'enr3b@example.com');
    const sa = secretFromUri(
      (await a.post(PLANNED.paths.totpEnroll, {})).json<{ otpauthUri: string }>().otpauthUri,
    );
    const sb = secretFromUri(
      (await b.post(PLANNED.paths.totpEnroll, {})).json<{ otpauthUri: string }>().otpauthUri,
    );
    expect(sa).not.toBe(sb);
    await app.close();
  });

  it('MFA-ENR-04: an unconfirmed factor is not active (login still single-factor, no recovery codes yet)', async () => {
    const app = await buildApp();
    const c = await signupAndLogin(app, 'enr4@example.com');
    await c.post(PLANNED.paths.totpEnroll, {});
    const status = (await c.get(PLANNED.paths.status)).json<{ enabled: boolean }>();
    expect(status.enabled).toBe(false);
    await app.close();
  });

  it('MFA-ENR-05: confirm with a wrong code fails generically and does not activate', async () => {
    const app = await buildApp();
    const c = await signupAndLogin(app, 'enr5@example.com');
    const { factorId } = (await c.post(PLANNED.paths.totpEnroll, {})).json<{ factorId: string }>();
    const bad = await c.post(PLANNED.paths.totpConfirm, {
      factorId,
      [PLANNED.totpField]: '000000',
    });
    expect([400, 401]).toContain(bad.statusCode);
    expect(errCode(bad)).toBe(PLANNED.errors.invalidCode);
    expect((await c.get(PLANNED.paths.status)).json<{ enabled: boolean }>().enabled).toBe(false);
    await app.close();
  });

  it('MFA-ENR-06: re-enroll while a factor is active requires step-up and replaces (never adds a silent second) secret', async () => {
    const app = await buildApp();
    const c = await signupAndLogin(app, 'enr6@example.com');
    await enrollTotp(c);
    const again = await c.post(PLANNED.paths.totpEnroll, {});
    expect(again.statusCode).toBe(403);
    expect(errCode(again)).toBe(PLANNED.errors.stepUpRequired);
    await app.close();
  });

  it('MFA-ENR-07: the factor id belongs to the caller (another user cannot confirm it)', async () => {
    const app = await buildApp();
    const a = await signupAndLogin(app, 'enr7a@example.com');
    const b = await signupAndLogin(app, 'enr7b@example.com');
    const e = (await a.post(PLANNED.paths.totpEnroll, {})).json<{
      factorId: string;
      otpauthUri: string;
    }>();
    const res = await b.post(PLANNED.paths.totpConfirm, {
      factorId: e.factorId,
      [PLANNED.totpField]: totp(secretFromUri(e.otpauthUri), Date.now()),
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});

describe('ADR-021 TOTP verification (MFA-TOTP)', () => {
  async function mfaUser(app: App, email: string) {
    const c = await signupAndLogin(app, email);
    const f = await enrollTotp(c);
    await c.post('/auth/logout');
    const fresh = new Client(app);
    const login = await fresh.post('/auth/login', { email, password: PASSWORD });
    return { c: fresh, login, ...f };
  }

  it('MFA-TOTP-01: password login of an MFA user is not elevated and cannot reach org data until the challenge', async () => {
    const app = await buildApp();
    const { c, login } = await mfaUser(app, 'totp1@example.com');
    expect(login.statusCode).toBe(200);
    expect(login.json<{ mfaRequired?: boolean }>().mfaRequired).toBe(true);
    const orgs = await c.get('/orgs');
    expect(orgs.statusCode).toBe(403);
    expect(errCode(orgs)).toBe(PLANNED.errors.mfaRequired);
    await app.close();
  });

  it('MFA-TOTP-02: a valid code elevates to auth_level=mfa and rotates the session id', async () => {
    const app = await buildApp();
    const { c, secret } = await mfaUser(app, 'totp2@example.com');
    const before = sidOf(c);
    const ok = await c.post(PLANNED.paths.challenge, {
      [PLANNED.totpField]: totp(secret, Date.now()),
    });
    expect(ok.statusCode).toBe(200);
    expect(sidOf(c)).not.toBe(before);
    expect(await sessionLevel(c)).toBe(PLANNED.levels.mfa);
    const stale = await app.inject({
      method: 'GET',
      url: '/auth/session',
      headers: { cookie: `${SID}=${before}` },
    });
    expect(stale.statusCode).toBe(401);
    await app.close();
  });

  it('MFA-TOTP-03: codes one step either side are accepted, two steps are not', async () => {
    // Adapted: enrolment already used the previous step (replay guard), so the HTTP case probes the window forwards;
    // the backwards slot is covered by the RFC 6238 unit tests in mfa-core.test.ts.
    const app = await buildApp();
    const { c, secret } = await mfaUser(app, 'totp3@example.com');
    for (const offset of [-65_000, 65_000]) {
      const far = await c.post(PLANNED.paths.challenge, {
        [PLANNED.totpField]: totp(secret, Date.now() + offset),
      });
      expect([400, 401]).toContain(far.statusCode);
    }
    const near = await c.post(PLANNED.paths.challenge, {
      [PLANNED.totpField]: totp(secret, Date.now() + 30_000),
    });
    expect(near.statusCode).toBe(200);
    await app.close();
  });

  it('MFA-TOTP-04: a code that was already accepted cannot be replayed (same or another session)', async () => {
    const app = await buildApp();
    const { c, secret } = await mfaUser(app, 'totp4@example.com');
    const code = totp(secret, Date.now());
    expect((await c.post(PLANNED.paths.challenge, { [PLANNED.totpField]: code })).statusCode).toBe(
      200,
    );
    const other = new Client(app);
    await other.post('/auth/login', { email: 'totp4@example.com', password: PASSWORD });
    const replay = await other.post(PLANNED.paths.challenge, { [PLANNED.totpField]: code });
    expect([400, 401]).toContain(replay.statusCode);
    await app.close();
  });

  it('MFA-TOTP-05: repeated wrong codes hit the rate limit and ADR-006 lockout; a correct code during lockout fails', async () => {
    const app = await buildApp();
    const { c, secret } = await mfaUser(app, 'totp5@example.com');
    let last = 0;
    for (let i = 0; i < 12; i++) {
      last = (await c.post(PLANNED.paths.challenge, { [PLANNED.totpField]: '000000' })).statusCode;
    }
    expect(last).toBe(429);
    const good = await c.post(PLANNED.paths.challenge, {
      [PLANNED.totpField]: totp(secret, Date.now()),
    });
    expect(good.statusCode).toBe(429);
    await app.close();
  });

  it('MFA-TOTP-06: malformed codes (length, non-digits, unicode digits, arrays) are 400 and never reach the verifier', async () => {
    const app = await buildApp();
    const { c } = await mfaUser(app, 'totp6@example.com');
    for (const v of ['', '12345', '1234567', '12a456', '١٢٣٤٥٦', ['123456'], 123456, null]) {
      const r = await c.post(PLANNED.paths.challenge, { [PLANNED.totpField]: v });
      expect(r.statusCode, JSON.stringify(v)).toBe(400);
    }
    await app.close();
  });
});

/* ------------------------------------------------------------------------------------------------------------------
 * ADR-021 piece (b) cases. The behaviour follows the decided defaults of the plan's §14 (ADR-021 Amendment 1). PR #470
 * (the plan update that adds MFA-TO and the OQ-17 wording) is not merged yet, so the cases below are copied from it.
 * ---------------------------------------------------------------------------------------------------------------- */
const MFA_COOKIE = SID.replace(/meetops_sid$/, 'meetops_mfa');

async function enrolledThenLoggedOut(app: App, email: string) {
  const c = await signupAndLogin(app, email);
  const f = await enrollTotp(c);
  expect((await c.post('/auth/logout')).statusCode).toBe(204);
  return f;
}
async function passwordStep(app: App, email: string) {
  const c = new Client(app);
  const login = await c.post('/auth/login', { email, password: PASSWORD });
  return { c, login };
}

describe('ADR-021 OQ-17 login challenge (copied from #470)', () => {
  it('OQ-17: an MFA login gets a short-lived HttpOnly SameSite=Strict challenge cookie, never a session', async () => {
    const app = await buildApp();
    await enrolledThenLoggedOut(app, 'oq17a@example.com');
    const { c, login } = await passwordStep(app, 'oq17a@example.com');
    expect(login.statusCode).toBe(200);
    expect(login.headers['cache-control']).toMatch(/no-store/);
    const body = login.json<{ mfaRequired?: boolean; organizations?: unknown[] }>();
    expect(body.mfaRequired).toBe(true);
    expect(body.organizations ?? []).toEqual([]);
    expect(sidOf(c)).toBeUndefined();
    const ch = login.cookies.find((k) => k.name === MFA_COOKIE);
    expect(ch?.httpOnly).toBe(true);
    expect(String(ch?.sameSite).toLowerCase()).toBe('strict');
    expect(ch?.maxAge).toBeLessThanOrEqual(300);
    // The challenge cannot call org APIs or read the session.
    for (const url of ['/orgs', '/auth/session']) {
      const r = await c.get(url);
      expect(r.statusCode, url).toBe(403);
      expect(errCode(r), url).toBe(PLANNED.errors.mfaRequired);
    }
    await app.close();
  });

  it('OQ-17: the challenge is single-use (a copied cookie is dead once the login completed)', async () => {
    const app = await buildApp();
    const { secret } = await enrolledThenLoggedOut(app, 'oq17b@example.com');
    const { c } = await passwordStep(app, 'oq17b@example.com');
    const copy = new Client(app);
    copy.jar = new Map(c.jar);
    expect(
      (await c.post(PLANNED.paths.challenge, { [PLANNED.totpField]: totp(secret, Date.now()) }))
        .statusCode,
    ).toBe(200);
    const again = await copy.post(PLANNED.paths.challenge, {
      [PLANNED.totpField]: totp(secret, Date.now() + 30_000),
    });
    expect(again.statusCode).toBe(401);
    await app.close();
  });

  it('OQ-17: without a challenge the endpoint is 401 and costs nothing', async () => {
    const app = await buildApp();
    const r = await new Client(app).post(PLANNED.paths.challenge, {
      [PLANNED.totpField]: '123456',
    });
    expect(r.statusCode).toBe(401);
    await app.close();
  });

  it('OQ-17: logout with only a challenge drops it (204)', async () => {
    const app = await buildApp();
    await enrolledThenLoggedOut(app, 'oq17d@example.com');
    const { c } = await passwordStep(app, 'oq17d@example.com');
    expect(c.jar.has(MFA_COOKIE)).toBe(true);
    expect((await c.post('/auth/logout')).statusCode).toBe(204);
    expect(c.jar.has(MFA_COOKIE)).toBe(false);
    await app.close();
  });

  it('MFA-ERR-01: a wrong password looks the same for MFA and non-MFA users (no challenge, no hint)', async () => {
    const app = await buildApp();
    await enrolledThenLoggedOut(app, 'err1a@example.com');
    await signupAndLogin(app, 'err1b@example.com');
    const [a, b] = await Promise.all(
      ['err1a@example.com', 'err1b@example.com'].map((email) =>
        new Client(app).post('/auth/login', { email, password: 'wrong-password-1' }),
      ),
    );
    expect(a!.statusCode).toBe(b!.statusCode);
    const strip = (r: typeof a) => {
      const { error } = r!.json<{ error: { code: string; message: string } }>();
      return { code: error.code, message: error.message };
    };
    expect(strip(a)).toEqual(strip(b));
    expect(a!.cookies.some((k) => k.name === MFA_COOKIE)).toBe(false);
    await app.close();
  });

  it('MFA-ERR-02: wrong TOTP, wrong recovery code and a used recovery code give the same generic error', async () => {
    const app = await buildApp();
    const { recoveryCodes } = await enrolledThenLoggedOut(app, 'err2@example.com');
    const first = await passwordStep(app, 'err2@example.com');
    expect(
      (await first.c.post(PLANNED.paths.challenge, { [PLANNED.recoveryField]: recoveryCodes[0] }))
        .statusCode,
    ).toBe(200);
    const { c } = await passwordStep(app, 'err2@example.com');
    const bodies = [];
    for (const proof of [
      { [PLANNED.totpField]: '000000' },
      { [PLANNED.recoveryField]: 'AAAAA-AAAAA' },
      { [PLANNED.recoveryField]: recoveryCodes[0] },
    ]) {
      const r = await c.post(PLANNED.paths.challenge, proof);
      expect(r.statusCode).toBe(400);
      bodies.push(errCode(r));
    }
    expect(new Set(bodies)).toEqual(new Set([PLANNED.errors.invalidCode]));
    await app.close();
  });

  it('MFA-TOTP-08 (OQ-4): password and MFA failures share one lockout budget', async () => {
    const app = await buildApp({ sleep: async () => {} });
    const { secret } = await enrolledThenLoggedOut(app, 'totp8@example.com');
    const bad = new Client(app);
    for (let i = 0; i < 6; i++)
      await bad.post('/auth/login', { email: 'totp8@example.com', password: 'wrong-password-1' });
    const { c } = await passwordStep(app, 'totp8@example.com');
    for (let i = 0; i < 4; i++)
      expect(
        (await c.post(PLANNED.paths.challenge, { [PLANNED.totpField]: '000000' })).statusCode,
      ).toBe(400);
    const good = await c.post(PLANNED.paths.challenge, {
      [PLANNED.totpField]: totp(secret, Date.now()),
    });
    expect(good.statusCode).toBe(429);
    await app.close();
  });

  it('MFA-RC-07: recovery-code attempts share the MFA limits and lockout', async () => {
    const app = await buildApp({ sleep: async () => {} });
    const { recoveryCodes } = await enrolledThenLoggedOut(app, 'rc7@example.com');
    const { c } = await passwordStep(app, 'rc7@example.com');
    for (let i = 0; i < 10; i++)
      await c.post(PLANNED.paths.challenge, { [PLANNED.recoveryField]: 'AAAAA-AAAAA' });
    const good = await c.post(PLANNED.paths.challenge, {
      [PLANNED.recoveryField]: recoveryCodes[0],
    });
    expect(good.statusCode).toBe(429);
    await app.close();
  });
});

describe('ADR-021 enrolment hardening (copied from #470)', () => {
  it('MFA-ENR-08: an unverified email cannot enrol (N-1 pre-hijack defence)', async () => {
    const app = await buildApp();
    const c = await signupAndLogin(app, 'enr8@example.com', PASSWORD, { verify: false });
    const r = await c.post(PLANNED.paths.totpEnroll, {});
    expect(r.statusCode).toBe(403);
    await app.close();
  });

  it('MFA-CSRF-02: every MFA POST refuses a missing CSRF token or a foreign Origin', async () => {
    const app = await buildApp();
    const c = await signupAndLogin(app, 'csrf2@example.com');
    for (const url of [
      PLANNED.paths.totpEnroll,
      PLANNED.paths.totpConfirm,
      PLANNED.paths.challenge,
    ]) {
      const noToken = await app.inject({
        method: 'POST',
        url,
        payload: {},
        headers: { cookie: c.cookie, origin: ORIGIN },
      });
      expect(noToken.statusCode, url).toBe(403);
      const evil = await c.post(url, {}, { origin: 'https://evil.example' });
      expect(evil.statusCode, url).toBe(403);
    }
    await app.close();
  });

  it('MFA-CSRF-03: the enrolment and confirm responses are no-store and cannot be framed', async () => {
    const app = await buildApp();
    const c = await signupAndLogin(app, 'csrf3@example.com');
    const e = await c.post(PLANNED.paths.totpEnroll, {});
    const { factorId, otpauthUri } = e.json<{ factorId: string; otpauthUri: string }>();
    const ok = await c.post(PLANNED.paths.totpConfirm, {
      factorId,
      [PLANNED.totpField]: totp(secretFromUri(otpauthUri), Date.now()),
    });
    for (const r of [e, ok]) {
      expect(r.headers['cache-control']).toMatch(/no-store/);
      expect(String(r.headers['content-security-policy'])).toMatch(/frame-ancestors 'none'/);
    }
    await app.close();
  });

  it('confirm turns MFA on, rotates the session to level mfa with a new CSRF token and signs out other sessions', async () => {
    const app = await buildApp();
    const c = await signupAndLogin(app, 'conf1@example.com');
    const other = new Client(app);
    await other.post('/auth/login', { email: 'conf1@example.com', password: PASSWORD });
    const sid = sidOf(c);
    const csrf = c.jar.get(CSRF_COOKIE);
    await enrollTotp(c);
    expect(sidOf(c)).not.toBe(sid);
    expect(c.jar.get(CSRF_COOKIE)).not.toBe(csrf);
    expect(await sessionLevel(c)).toBe(PLANNED.levels.mfa);
    expect((await other.get('/auth/session')).statusCode).toBe(401);
    // Confirm does not stamp a step-up: the first sensitive action still asks for the code (ENR-06).
    expect((await c.get('/orgs')).statusCode).toBe(200);
    await app.close();
  });

  it('MFA-AUD-01/02 (piece b): enrol, confirm and challenge success/failure are audited pre-tenant, without secrets', async () => {
    const audit = new InMemoryAuditLog();
    const app = await buildApp({ audit });
    const { secret, recoveryCodes, otpauthUri } = await enrolledThenLoggedOut(
      app,
      'audb@example.com',
    );
    const { c } = await passwordStep(app, 'audb@example.com');
    await c.post(PLANNED.paths.challenge, { [PLANNED.totpField]: '000000' });
    await c.post(PLANNED.paths.challenge, { [PLANNED.totpField]: totp(secret, Date.now()) });
    const mfaEvents = audit.events.filter((e) => String(e.action).startsWith('auth.mfa.'));
    expect(mfaEvents.map((e) => e.action as string)).toEqual(
      expect.arrayContaining([
        PLANNED.audit.enrolled,
        PLANNED.audit.confirmed,
        PLANNED.audit.challengeFailure,
        PLANNED.audit.challengeSuccess,
      ]),
    );
    for (const e of mfaEvents) expect(e.organizationId ?? null).toBeNull();
    const dump = JSON.stringify(audit.events);
    for (const v of [secret, otpauthUri, ...recoveryCodes]) expect(dump).not.toContain(v);
    await app.close();
  });
});

describe('ADR-021 recovery codes (MFA-RC)', () => {
  it('MFA-RC-01/02: a recovery code works once and is single-use', async () => {
    const app = await buildApp();
    const c = await signupAndLogin(app, 'rc1@example.com');
    const { recoveryCodes } = await enrollTotp(c);
    expect(recoveryCodes.length).toBeGreaterThanOrEqual(8);
    expect(new Set(recoveryCodes).size).toBe(recoveryCodes.length);
    await c.post('/auth/logout');
    const s1 = new Client(app);
    await s1.post('/auth/login', { email: 'rc1@example.com', password: PASSWORD });
    const ok = await s1.post(PLANNED.paths.challenge, {
      [PLANNED.recoveryField]: recoveryCodes[0],
    });
    expect(ok.statusCode).toBe(200);
    const s2 = new Client(app);
    await s2.post('/auth/login', { email: 'rc1@example.com', password: PASSWORD });
    const reuse = await s2.post(PLANNED.paths.challenge, {
      [PLANNED.recoveryField]: recoveryCodes[0],
    });
    expect([400, 401]).toContain(reuse.statusCode);
    await app.close();
  });

  it('MFA-RC-04: regenerate needs step-up, returns a fresh set and invalidates every old code', async () => {
    const app = await buildApp();
    const c = await signupAndLogin(app, 'rc4@example.com');
    const { recoveryCodes: old, secret } = await enrollTotp(c);
    const denied = await c.post(PLANNED.paths.recoveryCodes, {});
    expect(denied.statusCode).toBe(403);
    expect(errCode(denied)).toBe(PLANNED.errors.stepUpRequired);
    await c.post(PLANNED.paths.stepUp, { [PLANNED.totpField]: totp(secret, Date.now()) });
    const regen = await c.post(PLANNED.paths.recoveryCodes, {});
    expect(regen.headers['cache-control']).toMatch(/no-store/);
    expect(regen.statusCode).toBe(200);
    const fresh = regen.json<{ recoveryCodes: string[] }>().recoveryCodes;
    expect(fresh.some((x) => old.includes(x))).toBe(false);
    await c.post('/auth/logout');
    const s = new Client(app);
    await s.post('/auth/login', { email: 'rc4@example.com', password: PASSWORD });
    const stale = await s.post(PLANNED.paths.challenge, { [PLANNED.recoveryField]: old[1] });
    expect([400, 401]).toContain(stale.statusCode);
    await app.close();
  });

  it('MFA-RC-05: recovery codes are shown once; the status endpoint never returns them', async () => {
    const app = await buildApp();
    const c = await signupAndLogin(app, 'rc5@example.com');
    const { recoveryCodes } = await enrollTotp(c);
    const status = (await c.get(PLANNED.paths.status)).body;
    for (const rc of recoveryCodes) expect(status).not.toContain(rc);
    await app.close();
  });
});

describe('ADR-021 step-up (MFA-SU)', () => {
  it('MFA-SU-03: each step-up route returns 403 STEP_UP_REQUIRED on a session of an MFA user without a fresh step-up', async () => {
    // Adapted to OQ-17: a password login of an MFA user no longer yields a session at all (MFA_REQUIRED, covered by
    // MFA-TOTP-01). The session that lacks a step-up is the one right after confirm (elevated, never stamped).
    const app = await buildApp();
    const c = await signupAndLogin(app, 'su3@example.com');
    const org = (await c.post('/orgs', { name: 'SU' })).json<{ organization: { id: string } }>()
      .organization.id;
    await enrollTotp(c);
    const pw = c;
    for (const r of STEP_UP_ROUTES) {
      const url = r.url
        .replace(':organizationId', org)
        .replace(':userId', '00000000-0000-4000-8000-000000000009')
        .replace(':integrationId', '00000000-0000-4000-8000-000000000008');
      // Adapted: a body valid for each route (Fastify validates the body before the handler checks the step-up).
      const body =
        r.method === 'DELETE'
          ? undefined
          : r.method === 'PATCH'
            ? { role: 'member' }
            : { provider: 'jira' };
      const res = await pw.send(r.method, url, body);
      expect(res.statusCode, `${r.method} ${r.url}`).toBe(403);
      expect(errCode(res)).toBe(PLANNED.errors.stepUpRequired);
    }
    await app.close();
  });

  it('MFA-SU-04: step-up elevates, rotates the session id and re-issues CSRF', async () => {
    const app = await buildApp();
    const c = await signupAndLogin(app, 'su4@example.com');
    const { secret } = await enrollTotp(c);
    const before = sidOf(c);
    const up = await c.post(PLANNED.paths.stepUp, {
      [PLANNED.totpField]: totp(secret, Date.now()),
    });
    expect(up.statusCode).toBe(200);
    expect(sidOf(c)).not.toBe(before);
    expect(await sessionLevel(c)).toBe(PLANNED.levels.mfa);
    await app.close();
  });

  it('MFA-SU-05: a Google-only session cannot satisfy step-up without an MFA factor (N-4)', async () => {
    const app = await buildApp({
      users: new InMemoryUserRepository(),
      googleOAuth: {
        config: GOOGLE_CONFIG,
        client: fakeGoogle({
          sub: '100000000000000000005',
          email: 'su5@gmail.com',
          emailVerified: true,
          name: null,
        }),
      },
    });
    const c = await googleSignIn(app);
    expect(await sessionLevel(c)).not.toBe(PLANNED.levels.mfa);
    // OQ-3: Google's amr is never a second factor; without a factor there is nothing to step up with.
    const up = await c.post(PLANNED.paths.stepUp, { [PLANNED.totpField]: '123456' });
    expect(up.statusCode).toBe(403);
    expect(await sessionLevel(c)).not.toBe(PLANNED.levels.mfa);
    await app.close();
  });

  it('MFA-SU-06 (OQ-1): a step-up is fresh for 10 minutes, then required again', async () => {
    let offset = 0;
    const app = await buildApp({ clock: { now: () => new Date(Date.now() + offset) } });
    const c = await signupAndLogin(app, 'su6@example.com');
    const org = (await c.post('/orgs', { name: 'SU6' })).json<{ organization: { id: string } }>()
      .organization.id;
    const { secret } = await enrollTotp(c);
    const up = await c.post(PLANNED.paths.stepUp, {
      [PLANNED.totpField]: totp(secret, Date.now()),
    });
    expect(up.statusCode).toBe(200);
    const until = Date.parse(up.json<{ stepUpExpiresAt: string }>().stepUpExpiresAt);
    expect(until - Date.now()).toBeGreaterThan(9 * 60_000);
    expect(until - Date.now()).toBeLessThanOrEqual(10 * 60_000 + 1_000);
    const target = `/orgs/${org}/members/00000000-0000-4000-8000-000000000009`;
    expect(errCode(await c.patch(target, { role: 'member' }))).not.toBe(
      PLANNED.errors.stepUpRequired,
    );
    offset = 10 * 60_000 + 1_000;
    const late = await c.patch(target, { role: 'member' });
    expect(late.statusCode).toBe(403);
    expect(errCode(late)).toBe(PLANNED.errors.stepUpRequired);
    await app.close();
  });

  it('MFA-SU-07 (interpretation): an org switch keeps level mfa but drops the step-up', async () => {
    const app = await buildApp();
    const c = await signupAndLogin(app, 'su7@example.com');
    const { secret } = await enrollTotp(c);
    await c.post(PLANNED.paths.stepUp, { [PLANNED.totpField]: totp(secret, Date.now()) });
    // Creating an org rotates the session into it (org switch).
    const org = (await c.post('/orgs', { name: 'SU7' })).json<{ organization: { id: string } }>()
      .organization.id;
    expect(await sessionLevel(c)).toBe(PLANNED.levels.mfa);
    const r = await c.patch(`/orgs/${org}/members/00000000-0000-4000-8000-000000000009`, {
      role: 'member',
    });
    expect(errCode(r)).toBe(PLANNED.errors.stepUpRequired);
    await app.close();
  });

  it('OQ-9 / OQ-10: the extra sensitive routes also need a fresh step-up', async () => {
    const EXT = 'abcdefghijklmnopabcdefghijklmnop';
    const app = await buildApp({ extensionIds: [EXT], desktopAuthEnabled: true });
    const c = await signupAndLogin(app, 'oq910@example.com');
    const org = (await c.post('/orgs', { name: 'OQ910' })).json<{ organization: { id: string } }>()
      .organization.id;
    const other = new Client(app);
    await other.post('/auth/login', { email: 'oq910@example.com', password: PASSWORD });
    await enrollTotp(c);
    // enrolment signed the other session out; any session id other than ours exercises the check.
    const verifier = createHash('sha256').update(randomUUID()).digest('base64url');
    const cases: [string, string, object | undefined][] = [
      ['DELETE', `/orgs/${org}/members/00000000-0000-4000-8000-000000000009`, undefined],
      ['POST', `/orgs/${org}/invitations`, { email: 'new-admin@example.com', role: 'admin' }],
      ['POST', `/orgs/${org}/calendar/connect`, { provider: 'google', returnTo: '/calendar' }],
      [
        'DELETE',
        `/orgs/${org}/calendar/connections/00000000-0000-4000-8000-000000000007`,
        undefined,
      ],
      ['DELETE', '/auth/sessions/00000000-0000-4000-8000-000000000006', undefined],
      [
        'POST',
        '/auth/extension/pair',
        {
          extensionId: EXT,
          deviceId: randomUUID(),
          nonce: createHash('sha256').update(randomUUID()).digest('base64url'),
        },
      ],
      [
        'POST',
        '/auth/desktop/authorize',
        {
          codeChallenge: createHash('sha256').update(verifier).digest('base64url'),
          codeChallengeMethod: 'S256',
          redirectUri: 'http://127.0.0.1:53682/callback',
          deviceId: randomUUID(),
        },
      ],
      ['POST', PLANNED.paths.recoveryCodes, undefined],
    ];
    for (const [method, url, body] of cases) {
      const r = await c.send(method as 'POST' | 'DELETE', url, body);
      expect(r.statusCode, `${method} ${url}`).toBe(403);
      expect(errCode(r), `${method} ${url}`).toBe(PLANNED.errors.stepUpRequired);
    }
    // Not gated: inviting a member, leaving an org yourself, logging out.
    const member = await c.post(`/orgs/${org}/invitations`, {
      email: 'new-member@example.com',
      role: 'member',
    });
    expect(member.statusCode).toBe(201);
    await app.close();
  });

  it('users without MFA are not asked for a step-up (no factor to prove)', async () => {
    const app = await buildApp();
    const c = await signupAndLogin(app, 'nomfa@example.com');
    const org = (await c.post('/orgs', { name: 'NoMFA' })).json<{ organization: { id: string } }>()
      .organization.id;
    const r = await c.post(`/orgs/${org}/invitations`, { email: 'adm@example.com', role: 'admin' });
    expect(r.statusCode).toBe(201);
    await app.close();
  });
  it.todo(
    'MFA-SU-08: bearer clients (extension/desktop/mobile) get STEP_UP_REQUIRED on step-up routes, not a bypass',
  );
});

describe('ADR-021 session handling and disable (MFA-SES, MFA-DIS)', () => {
  it('MFA-DIS-01: disabling MFA needs step-up and revokes every other session', async () => {
    const app = await buildApp();
    const c = await signupAndLogin(app, 'dis1@example.com');
    const { factorId, secret, recoveryCodes } = await enrollTotp(c);
    const other = new Client(app);
    await other.post('/auth/login', { email: 'dis1@example.com', password: PASSWORD });
    // OQ-17: the second device needs the second factor too before it holds a session.
    expect(
      (await other.post(PLANNED.paths.challenge, { [PLANNED.recoveryField]: recoveryCodes[0] }))
        .statusCode,
    ).toBe(200);
    expect((await other.get('/auth/session')).statusCode).toBe(200);
    const denied = await c.delete(PLANNED.paths.factor(factorId));
    expect(denied.statusCode).toBe(403);
    await c.post(PLANNED.paths.stepUp, { [PLANNED.totpField]: totp(secret, Date.now()) });
    const ok = await c.delete(PLANNED.paths.factor(factorId));
    expect(ok.statusCode).toBe(204);
    expect((await other.get('/auth/session')).statusCode).toBe(401);
    expect((await c.get('/auth/session')).statusCode).toBe(200);
    expect((await c.get(PLANNED.paths.status)).json<{ enabled: boolean }>().enabled).toBe(false);
    // MFA is off: the next login is single-factor again.
    await c.post('/auth/logout');
    const again = new Client(app);
    const login = await again.post('/auth/login', {
      email: 'dis1@example.com',
      password: PASSWORD,
    });
    expect(login.json<{ mfaRequired?: boolean }>().mfaRequired).toBeUndefined();
    await app.close();
  });

  it('MFA-DIS-01: a foreign or unknown factor id is 404', async () => {
    const app = await buildApp();
    const a = await signupAndLogin(app, 'dis1a@example.com');
    const b = await signupAndLogin(app, 'dis1b@example.com');
    const { factorId } = await enrollTotp(a);
    expect((await b.delete(PLANNED.paths.factor(factorId))).statusCode).toBe(404);
    await app.close();
  });

  it('MFA-AUD-01/02: enroll, confirm, challenge success/failure, step-up and disable are audited without secrets', async () => {
    const audit = new InMemoryAuditLog();
    const app = await buildApp({ audit });
    const c = await signupAndLogin(app, 'aud1@example.com');
    const { secret, recoveryCodes, factorId } = await enrollTotp(c);
    await c.post(PLANNED.paths.stepUp, { [PLANNED.totpField]: totp(secret, Date.now()) });
    await c.post(PLANNED.paths.recoveryCodes, {});
    await c.delete(PLANNED.paths.factor(factorId));
    const actions = audit.events.map((e) => e.action as string);
    expect(actions).toEqual(
      expect.arrayContaining([
        PLANNED.audit.enrolled,
        PLANNED.audit.confirmed,
        PLANNED.audit.stepUp,
        PLANNED.audit.recoveryRegenerated,
        PLANNED.audit.disabled,
      ]),
    );
    const dump = JSON.stringify(audit.events);
    expect(dump).not.toContain(secret);
    for (const rc of recoveryCodes) expect(dump).not.toContain(rc);
    await app.close();
  });

  it('MFA-SES-04 (OQ-7): confirm and step-up keep the absolute expiry of the original sign-in', async () => {
    const sessions = new InMemorySessionRepository();
    const app = await buildApp({ sessions });
    const c = await signupAndLogin(app, 'ses4@example.com');
    const live = () => [...sessions.items.values()].filter((x) => !x.revokedAt);
    const [first] = live();
    const { secret } = await enrollTotp(c);
    await c.post(PLANNED.paths.stepUp, { [PLANNED.totpField]: totp(secret, Date.now()) });
    const now = live();
    expect(now).toHaveLength(1);
    expect(now[0]!.id).not.toBe(first!.id);
    expect(now[0]!.expiresAt.getTime()).toBe(first!.expiresAt.getTime());
    await app.close();
  });
  it.todo(
    'MFA-SES-05: MFA reset by an admin/support revokes all sessions, extension and desktop token families, push devices',
  );
  it.todo(
    'MFA-SES-06: refresh-token families issued from a password-level session never carry auth_level=mfa',
  );
  it.todo(
    'MFA-SES-07: realtime sockets are disconnected on MFA disable/reset (ADR-011 revocation fan-out)',
  );
});

describe('TODO(ADR-021) cases not automatable yet (it.todo)', () => {
  // Enrollment / secret storage
  it.todo(
    'MFA-SEC-01: TOTP secret stored only as a TokenCipher envelope bound to user+factor (P-3: tokenAad needs a user context)',
  );
  it.todo('MFA-SEC-02: recovery codes stored only as slow/keyed hashes; DB dump has no plaintext');
  it.todo('MFA-TOTP-07: code compare is constant-time (timingSafeEqual over fixed-length buffers)');
  // WebAuthn (ADR-021 Decision 1: passkeys)
  it.todo(
    'MFA-WA-01: registration rejects a clientDataJSON origin not in WEB_ORIGINS and an rpIdHash for another rpId',
  );
  it.todo('MFA-WA-02: challenges are single-use, server-generated, >=16 bytes, expire');
  it.todo(
    'MFA-WA-03: sign count that does not increase (non-zero) flags a cloned authenticator and fails',
  );
  it.todo('MFA-WA-04: user verification policy enforced per OPEN QUESTION OQ-8');
  it.todo(
    'MFA-WA-05: a credential id registered by user A cannot be used to authenticate as user B',
  );
  // OIDC
  // MFA-OIDC-02 (N-4) is active now: see MFA-OIDC-01/02 in the baseline block.
  it.todo(
    'MFA-OIDC-03: an owner/admin who signs in with Google still has to pass the MFA challenge',
  );
  it.todo('MFA-OIDC-04: amr/acr from Google are not trusted to elevate to mfa (OQ-3)');
  it.todo(
    'MFA-OIDC-05 (N-1): a pre-hijacked account cannot keep an attacker-enrolled factor after Google proves the email',
  );
  // Clients
  it.todo(
    'MFA-CLI-01: desktop authorize (ADR-012) of an MFA-required user only completes after the browser MFA step',
  );
  it.todo(
    'MFA-CLI-02: extension pairing (ADR-005) requires an mfa-level web session for MFA-required users',
  );
  it.todo(
    'MFA-CLI-03: mobile password login of an MFA-required user is refused or sent to the system browser (OQ-11)',
  );
  // Tenancy
  it.todo('MFA-TEN-01: owner/admin without MFA is blocked from org data (grace per OQ-5)');
  it.todo('MFA-TEN-02: org "require MFA for everyone" applies to members/viewers of that org only');
  it.todo(
    'MFA-TEN-03: org switch into an MFA-enforcing org from a password-level session is refused',
  );
  it.todo(
    'MFA-TEN-04: changing the org MFA policy needs owner/admin + step-up + audit; org B admins cannot read A members factors',
  );
  it.todo('MFA-TEN-05: promoting a member to admin who has no MFA follows OQ-5');
  // Recovery / support
  it.todo(
    'MFA-REC-01: losing all factors goes through the documented recovery path only (OQ-12); no email-only reset of MFA',
  );
  it.todo('MFA-REC-02: password reset does not disable MFA');
  it.todo(
    'MFA-REC-03: admin MFA reset of another member needs step-up, is audited and emails the member',
  );
  // Remaining plan cases (see mfa-test-plan.md for the expected behaviour)
  it.todo('MFA-ENR-09: an owner/admin without MFA can only reach the enrollment flow (OQ-5)');
  it.todo('MFA-RC-03: recovery codes are stored hashed and compared in constant time (OQ-6)');
  it.todo('MFA-RC-06: using a recovery code is audited and emails the user');
  it.todo('MFA-WA-06: only allowed COSE algorithms; attestation per OQ-8; no private key stored');
  it.todo('MFA-WA-07: passkey as first factor or second factor only, per OQ-8');
  it.todo('MFA-SU-09: any auth_level other than exactly "mfa" is treated as not elevated');
  it.todo('MFA-DIS-02: owners/admins (and enforcing-org members) cannot remove their last factor');
  it.todo('MFA-OIDC-06 (M-2): linking Google onto an account with MFA needs that account MFA');
  it.todo(
    'MFA-AUD-03: user-level MFA events are pre-tenant; policy changes and admin resets carry the org id (OQ-13)',
  );
  it.todo('MFA-REC-04: support runbook for lost factors (manual / tabletop, OQ-12)');
  it.todo('MFA-SEC-07: verifier errors, metrics and traces never contain codes or secrets');
  it.todo(
    'MFA-ERR-03: admins see MFA on/off for members, never factor detail or recovery-code counts',
  );
});
