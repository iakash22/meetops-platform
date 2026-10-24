import { describe, it } from 'vitest';
import { ssrfPayloads } from '../fixtures/security/ssrf.js';
import { authAbuseCases, crossOrganizationCases, uploadCases } from './cases.js';
import { todoAu, todoSs, todoUp, todoXt } from './status.js';

/*
 * Every catalogue case that cannot run yet is an `it.todo` carrying its reason, so the
 * reporter counts them as todo (not skipped, not passed). Implemented cases live in the
 * files listed in security/status.ts.
 */
const groups = [
  { name: 'XT cross-organization', cases: crossOrganizationCases, todo: todoXt },
  { name: 'AU auth abuse', cases: authAbuseCases, todo: todoAu },
  { name: 'UP chunked upload', cases: uploadCases, todo: todoUp },
  {
    name: 'SS SSRF',
    cases: ssrfPayloads.map((p) => ({
      id: p.id,
      title: p.note,
      steps: p.kind === 'url' ? p.urls.join(' ') : p.description,
      expected: 'rejected',
    })),
    todo: todoSs,
  },
];

for (const g of groups)
  describe(`security catalogue todo: ${g.name}`, () => {
    for (const c of g.cases.filter((x) => g.todo[x.id]))
      it.todo(`[${c.id}] ${c.title}: ${c.steps} -> ${c.expected} (todo: ${g.todo[c.id]})`);
  });
