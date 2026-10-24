// lint-staged: test folders are covered by test/tsconfig.json projects (see #106)
// Flat ESLint config for monorepo
/* global process */
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import eslintPluginUnusedImports from 'eslint-plugin-unused-imports';

// Set ESLINT_NO_TYPECHECK=1 (used by the pre-commit hook via lint-staged) to skip
// type-aware parsing/rules for fast feedback. `pnpm lint` and CI run the full config.
const noTypecheck = process.env.ESLINT_NO_TYPECHECK === '1';

const tsFiles = ['**/*.ts', '**/*.tsx'];

const tsConfigs = noTypecheck
  ? tseslint.configs.recommended.map((c) => ({ ...c, files: tsFiles }))
  : [
      ...tseslint.configs.recommendedTypeChecked.map((c) => ({
        ...c,
        files: tsFiles,
        languageOptions: {
          ...c.languageOptions,
          parserOptions: {
            ...c.languageOptions?.parserOptions,
            // Resolve each file against its nearest tsconfig.json (per-package paths/aliases such as @/)
            // Every linted TS file must belong to a real tsconfig: package test/ dirs each have a
            // test/tsconfig.json. No allowDefaultProject fallback, so large staged sets (e.g. merge
            // commits) never hit the default-project file-count cap.
            projectService: true,
            tsconfigRootDir: import.meta.dirname,
          },
        },
      })),
      {
        // apps/web relies on its own tsconfig (Bundler resolution + "@/" paths). Pin it
        // explicitly so type-aware rules never fall back to a project without the alias.
        // Omitted entirely in fast mode (no project/projectService).
        files: ['apps/web/**/*.ts', 'apps/web/**/*.tsx'],
        languageOptions: {
          parserOptions: {
            projectService: false,
            project: ['./tsconfig.eslint.web.json'],
            tsconfigRootDir: import.meta.dirname,
          },
        },
      },
    ];

const typeAwareRules = noTypecheck
  ? {}
  : {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
    };

/**
 * Architecture boundaries (enforced with @typescript-eslint/no-restricted-imports, no extra plugin).
 * ESLint replaces (does not merge) a rule's options when a later config block sets it again, so every block that
 * sets the rule must go through `boundaryImports()` to keep the base restrictions.
 */
const DEEP_IMPORT_PATTERNS = [
  {
    group: ['@meetops/*/src', '@meetops/*/src/**', '@meetops/*/dist', '@meetops/*/dist/**'],
    message:
      "Import the package entry (e.g. '@meetops/contracts' or '@meetops/contracts/types'), not its src/ or dist/.",
  },
  {
    regex: '^(\\.\\./)+(apps|packages)/[^/]+/(src|dist)(/|$)',
    message:
      "Do not reach into another workspace's src/ or dist/ by relative path; depend on its package entry.",
  },
  {
    // Sibling workspace by relative path without the apps/ or packages/ segment, e.g. '../../../api/src/x'.
    regex: '^(\\.\\./){2,}[A-Za-z0-9_-]+/(src|dist)(/|$)',
    message:
      "Do not reach into another workspace's src/ or dist/ by relative path; depend on its package entry.",
  },
];
const APP_NAMES = ['api', 'web', 'worker', 'realtime', 'extension'];
/** apps/* must not import other apps (by package name or by relative path through apps/). */
export const appBoundaryPatterns = (self) => [
  {
    group: APP_NAMES.filter((a) => a !== self).flatMap((a) => [
      `@meetops/${a}`,
      `@meetops/${a}/**`,
    ]),
    message: 'Apps must not import other apps; move shared code to a package under packages/.',
  },
  {
    regex: `(^|/)apps/(${APP_NAMES.filter((a) => a !== self).join('|')})(/|$)`,
    message: 'Apps must not import other apps; move shared code to a package under packages/.',
  },
];
/** UI bundles: values from '@meetops/contracts/types' only; the root entry is allowed for `import type`. */
export const UI_CONTRACTS_PATHS = [
  {
    name: '@meetops/contracts',
    allowTypeImports: true,
    message:
      "UI bundles: use `import type` from '@meetops/contracts', or import values from '@meetops/contracts/types' (no TypeBox at runtime).",
  },
];
export const boundaryImports = ({ patterns = [], paths = [] } = {}) => [
  'error',
  { patterns: [...DEEP_IMPORT_PATTERNS, ...patterns], paths },
];
const SERVER_APPS = ['api', 'worker', 'realtime'];

/** @type {import('eslint').Linter.FlatConfig[]} */
export default [
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      '.turbo/**',
      '**/.vite/**',
      '**/coverage/**',
    ],
  },
  // Fast mode does not load type-aware rules, so their eslint-disable directives look unused;
  // without this, `eslint --fix` in the pre-commit hook would delete them and break full lint.
  ...(noTypecheck ? [{ linterOptions: { reportUnusedDisableDirectives: 'off' } }] : []),
  js.configs.recommended,
  ...tsConfigs,
  {
    files: tsFiles,
    plugins: {
      'unused-imports': eslintPluginUnusedImports,
      '@typescript-eslint': tseslint.plugin,
    },
    rules: {
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      'no-debugger': 'warn',
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/no-redundant-type-constituents': 'off',
      ...typeAwareRules,
      'unused-imports/no-unused-imports': 'error',
    },
  },
  {
    files: ['**/*.ts', '**/*.tsx', '**/*.mts'],
    rules: { '@typescript-eslint/no-restricted-imports': boundaryImports() },
  },
  // Server apps lint with this root config directly (no own config), so their paths resolve from the repo root.
  // apps/web and apps/extension set their own app-boundary and UI rules in their eslint.config.mjs.
  ...SERVER_APPS.map((app) => ({
    files: [`apps/${app}/**/*.ts`, `apps/${app}/**/*.mts`],
    rules: {
      '@typescript-eslint/no-restricted-imports': boundaryImports({
        patterns: appBoundaryPatterns(app),
      }),
    },
  })),
];
