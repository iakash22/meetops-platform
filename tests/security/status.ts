/**
 * Status of every security catalogue case (docs/12-security/test-cases.md): either implemented
 * (file that contains a test titled with the `[ID]`) or todo with the reason it cannot run yet.
 * security/catalogue.test.ts enforces that every ID has exactly one of the two.
 */
export type Implemented = { file: string; note?: string };

const NO_ENDPOINT = 'API has no such endpoint yet (auth, orgs and invitations only)';
const NO_REC = 'API has no recording-sessions routes yet (contracts v0.3 define them)';

const range = (p: string, from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => `${p}-${String(from + i).padStart(2, '0')}`);

// ---- XT: cross-organization ----
export const implementedXt: Record<string, Implemented> = {
  'XT-01': {
    file: 'integration/xt-db.test.ts',
    note: '+ api/auth/cross-org.test.ts (GET /orgs/{B})',
  },
  'XT-02': { file: 'integration/xt-db.test.ts' },
  'XT-03': { file: 'integration/xt-db.test.ts' },
  'XT-04': { file: 'integration/xt-db.test.ts', note: '+ api/auth/cross-org.test.ts (GET /orgs)' },
  'XT-10': { file: 'integration/xt-db.test.ts' },
  'XT-13': { file: 'integration/xt-db.test.ts' },
  'XT-14': { file: 'integration/xt-db.test.ts' },
  'XT-21': { file: 'api/auth/cross-org.test.ts', note: 'invitations; no GET /members yet' },
  'XT-26': { file: 'integration/rls.test.ts' },
  'XT-27': { file: 'integration/rls.test.ts' },
  'XT-28': { file: 'integration/rls.test.ts' },
  'XT-29': { file: 'integration/rls.test.ts' },
  'XT-30': {
    file: 'api/auth/cross-org.test.ts',
    note: 'POST /orgs/switch (BE-GAP-2 client-resolved: web calls /orgs/switch)',
  },
};
export const todoXt: Record<string, string> = {
  'XT-05': `${NO_ENDPOINT}: transcripts`,
  'XT-06': `${NO_ENDPOINT}: transcripts`,
  'XT-07': `${NO_ENDPOINT}: summaries`,
  'XT-08': `${NO_ENDPOINT}: tasks`,
  'XT-09': `${NO_ENDPOINT}: tasks`,
  'XT-11': `${NO_ENDPOINT}: tasks`,
  'XT-12': `${NO_ENDPOINT}: task approval`,
  'XT-15': `${NO_ENDPOINT}: files / presign`,
  'XT-16': `${NO_ENDPOINT}: uploads`,
  'XT-17': `${NO_ENDPOINT}: uploads`,
  'XT-18': `${NO_ENDPOINT}: integrations`,
  'XT-19': `${NO_ENDPOINT}: integrations push`,
  'XT-20': `${NO_ENDPOINT}: AI provider config`,
  'XT-22': `${NO_ENDPOINT}: audit log`,
  'XT-23': 'Realtime gateway not wired to auth yet',
  'XT-24': 'Worker job handlers with org checks not implemented yet',
  'XT-25': 'Worker media jobs not implemented yet',
  ...Object.fromEntries(range('XT', 31, 36).map((id) => [id, NO_REC])),
};

// ---- AU: auth abuse ----
const AU_DONE = [
  1, 2, 3, 4, 5, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 21, 22, 23, 24, 25, 26, 27, 28,
];
export const implementedAu: Record<string, Implemented> = {
  ...Object.fromEntries(
    AU_DONE.map((n) => [
      `AU-${String(n).padStart(2, '0')}`,
      { file: 'api/auth/auth-abuse.test.ts' },
    ]),
  ),
  'AU-20': { file: 'e2e/flow/app.flow.ts', note: 'Playwright; runs with QA_WEB_DIR/QA_API_DIR' },
};
export const todoAu: Record<string, string> = {
  'AU-06':
    'Timing test needs the real argon2 hasher and many samples; too flaky for CI. Planned as an opt-in perf job',
  'AU-29': 'No member role-change endpoint (PATCH /members) yet',
  'AU-30': 'No member role-change/remove endpoint yet',
  'AU-31': 'No member role-change endpoint yet',
  'AU-32':
    'Task endpoints do not exist yet (viewer invite refusal is covered as "AU-32 (org scope)")',
  'AU-33': 'Guest role is not in the contracts Role union yet',
  'AU-34': 'No AI provider config endpoints yet',
  'AU-35': 'No PATCH /me endpoint yet',
};

// ---- UP: chunked recording upload ----
const UP_CONTRACT = 'contract/recording-sessions.test.ts checks the request schema';
export const implementedUp: Record<string, Implemented> = {};
export const todoUp: Record<string, string> = {
  ...Object.fromEntries(range('UP', 1, 15).map((id) => [id, NO_REC])),
  'UP-01': `${NO_REC}; ${UP_CONTRACT}`,
  'UP-02': `${NO_REC}; ${UP_CONTRACT}`,
  'UP-03': `${NO_REC}; also needs S3/MinIO signed-PUT harness`,
  'UP-04': `${NO_REC}; also needs S3/MinIO signed-PUT harness`,
  'UP-06': `${NO_REC}; ${UP_CONTRACT}`,
  'UP-10': `${NO_REC}; also needs S3/MinIO and a 300 s expiry (fake clock)`,
  'UP-13': `${NO_REC}; ${UP_CONTRACT}`,
  'UP-14': `${NO_REC}; ${UP_CONTRACT}`,
  'UP-15': `${NO_REC}; ${UP_CONTRACT} (response schema has no bucket/key)`,
};

// ---- SS: SSRF (PR #21 assertSafeEndpoint) ----
const SS_URL = [...range('SS', 1, 17), ...range('SS', 21, 28)];
export const implementedSs: Record<string, Implemented> = {
  ...Object.fromEntries(
    SS_URL.map((id) => [
      id,
      { file: 'security/ssrf.test.ts', note: 'assertSafeEndpoint (PR #21); skipped without it' },
    ]),
  ),
  'SS-18': { file: 'security/ssrf.test.ts', note: 'pinning + mixed public/private resolution' },
};
export const todoSs: Record<string, string> = {
  'SS-19': 'Redirect handling lives in the HTTP adapter, needs a test server (PR #21 adapters)',
  'SS-20': 'Redirect chain limit needs a test server (PR #21 adapters)',
  'SS-29': 'Response size cap needs a test server (PR #21 adapters)',
  'SS-30': 'Slow-response timeout needs a test server (PR #21 adapters)',
  'SS-31': 'TLS validation needs a self-signed test server',
  'SS-32': 'Provider config endpoint (registry ids only) does not exist yet',
};
