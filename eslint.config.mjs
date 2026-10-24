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
            // Only test dirs NOT covered by a tsconfig "include" may use the default project;
            // apps/web includes test/ in its own tsconfig, so it must not be listed here.
            projectService: {
              allowDefaultProject: [
                'apps/api/test/*.ts',
                'apps/worker/test/*.ts',
                'packages/*/test/*.ts',
              ],
              defaultProject: 'tsconfig.base.json',
              maximumDefaultProjectFileMatchCount_THIS_WILL_SLOW_DOWN_LINTING: 32,
            },
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
];
