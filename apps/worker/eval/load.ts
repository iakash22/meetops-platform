import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import type { GoldenItem } from './score.js';
import type { SummaryTranscript } from '../src/ai/summary-repository.js';

const Uuid = Type.String({
  pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$',
});

const EvalSegment = Type.Object(
  {
    id: Uuid,
    sequence: Type.Integer({ minimum: 0 }),
    speakerLabel: Type.Union([Type.String(), Type.Null()]),
    startMs: Type.Integer({ minimum: 0 }),
    endMs: Type.Integer({ minimum: 0 }),
    text: Type.String(),
  },
  { additionalProperties: false },
);

const EvalTranscript = Type.Object(
  {
    transcriptId: Uuid,
    recordingId: Uuid,
    revision: Type.Integer({ minimum: 1 }),
    language: Type.Union([Type.String(), Type.Null()]),
    segments: Type.Array(EvalSegment, { minItems: 1 }),
  },
  { additionalProperties: false },
);

const GoldenItemSchema = Type.Object(
  {
    title: Type.String({ minLength: 1 }),
    owner: Type.Union([Type.String(), Type.Null()]),
    due: Type.Union([Type.String(), Type.Null()]),
  },
  { additionalProperties: false },
);

const Thresholds = Type.Object(
  {
    precision: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
    recall: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
    decisionRecall: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
    decisionPrecision: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
  },
  { additionalProperties: false },
);

export const EvalFixtureSchema = Type.Object(
  {
    name: Type.String({ minLength: 1 }),
    description: Type.String({ minLength: 1 }),
    transcript: EvalTranscript,
    golden: Type.Object(
      {
        actionItems: Type.Array(GoldenItemSchema),
        decisions: Type.Array(Type.String()),
        forbidden: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
        thresholds: Type.Optional(Thresholds),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export type EvalFixture = Static<typeof EvalFixtureSchema> & {
  transcript: SummaryTranscript;
  golden: {
    actionItems: GoldenItem[];
    decisions: string[];
    forbidden?: string[];
    thresholds?: {
      precision?: number;
      recall?: number;
      decisionRecall?: number;
      decisionPrecision?: number;
    };
  };
};

const bundledFixturesDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

export function findRepoRoot(startDir: string): string {
  let dir = resolve(startDir);
  for (;;) {
    if (existsSync(join(dir, '.git'))) return dir;
    const parent = resolve(dir, '..');
    if (parent === dir) throw new Error(`Could not find repo root from ${startDir}`);
    dir = parent;
  }
}

export function isInsideRepo(absPath: string, repoRoot: string): boolean {
  const rel = relative(resolve(repoRoot), resolve(absPath));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * Resolves EVAL_DATA_DIR. Must be an absolute directory outside the repo root.
 * Symlinks that resolve inside the repo are refused too. Never logs directory contents.
 */
export function resolveEvalDataDir(dir: string, repoRoot: string): string {
  if (!dir || !isAbsolute(dir)) {
    throw new Error('EVAL_DATA_DIR must be an absolute path outside the repo');
  }
  const resolved = resolve(dir);
  const real = existsSync(resolved) ? realpathSync(resolved) : resolved;
  if (isInsideRepo(resolved, repoRoot) || isInsideRepo(real, repoRoot)) {
    throw new Error(
      `EVAL_DATA_DIR must be a directory outside the repo root (${repoRoot}); refused ${resolved}`,
    );
  }
  if (!existsSync(real) || !lstatSync(real).isDirectory()) {
    throw new Error(`EVAL_DATA_DIR is not a directory: ${resolved}`);
  }
  return real;
}

function formatSchemaErrors(value: unknown): string {
  return [...Value.Errors(EvalFixtureSchema, value)]
    .map((e) => `${e.path || '/'} ${e.message}`)
    .join('; ');
}

/** Parse and schema-validate one fixture file. Errors always name the file, never the transcript text. */
export function loadFixtureFile(file: string): EvalFixture {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`Invalid eval fixture ${file}: ${(err as Error).message}`);
  }
  if (!Value.Check(EvalFixtureSchema, raw)) {
    throw new Error(`Invalid eval fixture ${file}: ${formatSchemaErrors(raw)}`);
  }
  return raw;
}

export function listFixtureFiles(dir: string): string[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => join(dir, f));
}

export type LoadFixturesOptions = {
  env?: NodeJS.ProcessEnv;
  bundledDir?: string;
  repoRoot?: string;
};

/**
 * Bundled fixtures from `eval/fixtures/`, plus optional EVAL_DATA_DIR (absolute, outside the repo).
 * Off by default. Refused in CI. Never logs fixture content — callers should log file names and scores only.
 */
export function loadFixtures(opts: LoadFixturesOptions = {}): EvalFixture[] {
  const env = opts.env ?? process.env;
  const bundledDir = opts.bundledDir ?? bundledFixturesDir;
  const repoRoot = opts.repoRoot ?? findRepoRoot(bundledDir);
  const files = listFixtureFiles(bundledDir);
  if (env.EVAL_DATA_DIR) {
    if (env.CI === 'true' || env.GITHUB_ACTIONS === 'true') {
      throw new Error('EVAL_DATA_DIR must not be set in CI');
    }
    const extraDir = resolveEvalDataDir(env.EVAL_DATA_DIR, repoRoot);
    files.push(...listFixtureFiles(extraDir));
  }
  const loaded: EvalFixture[] = [];
  const names = new Map<string, string>();
  for (const file of files) {
    const fx = loadFixtureFile(file);
    const prev = names.get(fx.name);
    if (prev) {
      throw new Error(
        `Duplicate eval fixture name "${fx.name}" in ${file} (already loaded from ${prev})`,
      );
    }
    names.set(fx.name, file);
    loaded.push(fx);
  }
  return loaded;
}
