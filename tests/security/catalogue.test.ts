import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ssrfPayloads } from '../fixtures/security/ssrf.js';
import { authAbuseCases, crossOrganizationCases, uploadCases } from './cases.js';
import * as S from './status.js';

const testsDir = fileURLToPath(new URL('..', import.meta.url));
const ids = (p: string, n: number) =>
  Array.from({ length: n }, (_, i) => `${p}-${String(i + 1).padStart(2, '0')}`);

const groups = [
  {
    p: 'XT',
    n: 36,
    got: crossOrganizationCases.map((c) => c.id),
    done: S.implementedXt,
    todo: S.todoXt,
  },
  { p: 'AU', n: 35, got: authAbuseCases.map((c) => c.id), done: S.implementedAu, todo: S.todoAu },
  { p: 'UP', n: 15, got: uploadCases.map((c) => c.id), done: S.implementedUp, todo: S.todoUp },
  { p: 'SS', n: 32, got: ssrfPayloads.map((c) => c.id), done: S.implementedSs, todo: S.todoSs },
];

describe('security case catalogue', () => {
  it('covers 118 cases: XT-01..36, AU-01..35, UP-01..15, SS-01..32', () => {
    for (const g of groups) expect(g.got, g.p).toEqual(ids(g.p, g.n));
    expect(groups.reduce((n, g) => n + g.got.length, 0)).toBe(118);
  });

  it('every ID is either implemented or todo with a reason (never both, never neither)', () => {
    for (const g of groups)
      for (const id of g.got) {
        const done = Boolean(g.done[id]);
        const reason = g.todo[id];
        expect(done !== Boolean(reason), `${id}: implemented=${done} todo=${reason ?? '-'}`).toBe(
          true,
        );
        if (reason) expect(reason.trim().length, `${id} reason`).toBeGreaterThan(10);
      }
  });

  it('status maps contain no unknown IDs', () => {
    for (const g of groups)
      for (const id of [...Object.keys(g.done), ...Object.keys(g.todo)])
        expect(g.got, `${id} is not in the catalogue`).toContain(id);
  });

  it('each implemented ID points at an existing file that has a test tagged with it', () => {
    for (const g of groups)
      for (const [id, impl] of Object.entries(g.done)) {
        const file = join(testsDir, impl.file);
        expect(existsSync(file), `${id}: ${impl.file} missing`).toBe(true);
        const src = readFileSync(file, 'utf8');
        // SS IDs come from the fixture rows the test iterates over; others are literal titles.
        const tagged =
          g.p === 'SS'
            ? src.includes('ssrfUrlPayloads') || src.includes(id)
            : src.includes(`[${id}`);
        expect(tagged, `${id}: no test tagged [${id}] in ${impl.file}`).toBe(true);
      }
  });

  it('every ID in the repo doc (if present) is in the catalogue', () => {
    const doc = join(testsDir, '../docs/12-security/test-cases.md');
    if (!existsSync(doc)) return;
    const all = new Set(groups.flatMap((g) => g.got));
    const inDoc = [...readFileSync(doc, 'utf8').matchAll(/^\|\s*((?:XT|AU|UP|SS)-\d+)\s*\|/gm)].map(
      (m) => m[1]!,
    );
    for (const id of inDoc) expect(all.has(id), `${id} from docs missing in cases.ts`).toBe(true);
  });
});
