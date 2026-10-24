import { describe, it, expect, expectTypeOf, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pkg from '../package.json' with { type: 'json' };
import type { ApiErrorCode, SttProviderId, TranscriptProviderId, ExtensionTokenResponse, Role, TaskStatus } from '../src/types.js';
import type * as Full from '../src/index.js';

vi.mock('@sinclair/typebox', () => {
  throw new Error('@sinclair/typebox must not be loaded by @meetops/contracts/types');
});

const srcDir = resolve(dirname(fileURLToPath(import.meta.url)), '../src');

/** Runtime (non-type-only) import/export specifiers of a TS source file. */
function runtimeSpecifiers(file: string): string[] {
  const code = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  const out: string[] = [];
  for (const m of code.matchAll(/^\s*(import|export)\s+(?!type\b)[^;]*?from\s+['"]([^'"]+)['"]/gm)) out.push(m[2]!);
  for (const m of code.matchAll(/^\s*import\s+['"]([^'"]+)['"]/gm)) out.push(m[1]!);
  for (const m of code.matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/g)) out.push(m[1]!);
  return out;
}

function runtimeGraph(entry: string, seen = new Set<string>()): Set<string> {
  if (seen.has(entry)) return seen;
  seen.add(entry);
  for (const spec of runtimeSpecifiers(entry)) {
    if (spec.startsWith('.')) runtimeGraph(resolve(dirname(entry), spec.replace(/\.js$/, '.ts')), seen);
    else seen.add(spec);
  }
  return seen;
}

describe('@meetops/contracts/types (light entry)', () => {
  it('runtime import graph has no @sinclair/typebox', () => {
    const graph = [...runtimeGraph(resolve(srcDir, 'types.ts'))];
    expect(graph.some((s) => s.includes('typebox'))).toBe(false);
    expect(graph.every((s) => s.startsWith(srcDir))).toBe(true);
  });
  it('loads with typebox mocked to throw, and exports constants only', async () => {
    const T = await import('../src/types.js');
    expect(T.EXTENSION_TOKEN_TTL_SECONDS).toBe(900);
    expect(T.EXTENSION_AUTH_PATHS.refresh).toBe('/auth/extension/refresh');
    expect(T.REDACT_KEYS).toContain('refreshToken');
    expect(T.TASK_STATUSES).toEqual(['todo', 'in_progress', 'done', 'cancelled']);
    expect(T.MAX_CHUNKS).toBe(10_000);
    expect(T.MAX_CHUNK_BYTES).toBe(64 * 1024 * 1024);
    expect(T.MAX_DURATION_MS).toBe(86_400_000);
    // The four upload limits mirrored in apps/extension/src/lib/contract-limits.ts (PR #60).
    expect(T.CHUNK_UPLOAD_URL_TTL_SECONDS).toBe(300);
    expect(T.MAX_RECORDING_CHUNKS).toBe(10_000);
    expect(T.MAX_CHUNKS).toBe(T.MAX_RECORDING_CHUNKS);
    expect(T.PAIRING_CODE_MESSAGE_TYPE).toBe('MEETOPS_PAIRING_CODE');
    for (const v of Object.values(T)) expect(typeof v === 'object' && v !== null && 'type' in v && '[Kind]' in v).toBe(false);
  });
  it('the mock is live: the full entry fails to load', async () => {
    await expect(import('../src/index.js')).rejects.toThrow();
  });
  it('constants match the schemas, and types match the main entry', () => {
    expectTypeOf<(typeof Full.TASK_STATUSES)[number]>().toEqualTypeOf<TaskStatus>();
    expectTypeOf<(typeof Full.ROLES)[number]>().toEqualTypeOf<Role>();
    expectTypeOf<(typeof Full.API_ERROR_CODES)[number]>().toEqualTypeOf<ApiErrorCode>();
    expectTypeOf<(typeof Full.STT_PROVIDER_IDS)[number]>().toEqualTypeOf<SttProviderId>();
    expectTypeOf<(typeof Full.TRANSCRIPT_PROVIDER_IDS)[number]>().toEqualTypeOf<TranscriptProviderId>();
    expectTypeOf<ExtensionTokenResponse>().toEqualTypeOf<Full.ExtensionTokenResponse>();
  });
  it('package.json exposes ./types and sideEffects: false', () => {
    expect(pkg.sideEffects).toBe(false);
    expect(pkg.exports['./types']).toEqual({ types: './src/types.ts', import: './dist/types.js', default: './dist/types.js' });
  });
});
