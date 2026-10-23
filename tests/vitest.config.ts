import { createRequire } from 'node:module';
import { defineConfig } from 'vitest/config';
import { projects } from './vitest.projects.js';

// vitest 4 (#33) removes defineWorkspace and the workspace option; `test.projects` exists
// since 3.2. Pick the mechanism from the installed version so the suite runs on 2.x and 4.x.
const [major = 0, minor = 0] = (
  createRequire(import.meta.url)('vitest/package.json') as { version: string }
).version
  .split('.')
  .map(Number);
const supportsProjects = major > 3 || (major === 3 && minor >= 2);

// Typed loosely on purpose: `projects` is missing from vitest 2 types, `workspace` from vitest 4.
const selection: object = supportsProjects ? { projects } : { workspace: './vitest.projects.ts' };

export default defineConfig({ test: selection });
