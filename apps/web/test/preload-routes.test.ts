import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LAZY_ROUTE_MODULES, LAZY_ROUTE_SPECIFIERS } from './fixtures/preload-routes';

describe('test preload list', () => {
  it('covers every lazy import() in src/routes', () => {
    const dir = join(__dirname, '../src/routes');
    const found = new Set<string>();
    for (const f of readdirSync(dir)) {
      for (const m of readFileSync(join(dir, f), 'utf8').matchAll(/import\('([^']+)'\)/g)) {
        found.add(m[1]!);
      }
    }
    expect([...found].sort()).toEqual([...LAZY_ROUTE_SPECIFIERS].sort());
    expect(LAZY_ROUTE_MODULES).toHaveLength(LAZY_ROUTE_SPECIFIERS.length);
  });
});
