/* global URL, console, process */
// Production build check (Coordinator review on #161): the dist output must contain no mock-auth chunk
// and no mock sign-in code or copy. Runs after `vite build` (production mode).
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = new URL('../dist/assets/', import.meta.url).pathname;
const FORBIDDEN = [
  'createMockAuthClient',
  'sign-in is mocked',
  'sign-up is mocked',
  'VITE_DESKTOP_MOCK_AUTH',
];
const problems = [];
for (const file of readdirSync(dir)) {
  if (/mock/i.test(file)) problems.push(`mock chunk emitted: ${file}`);
  const text = readFileSync(join(dir, file), 'utf8');
  for (const s of FORBIDDEN) if (text.includes(s)) problems.push(`"${s}" found in ${file}`);
}
if (problems.length) {
  console.error('Production bundle check FAILED:\n' + problems.join('\n'));
  process.exit(1);
}
console.log('Production bundle check passed: no mock-auth chunk or strings.');
