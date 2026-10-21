// Flat ESLint config for monorepo
/* global process */
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import eslintPluginUnusedImports from 'eslint-plugin-unused-imports';

// Set ESLINT_NO_TYPECHECK=1 (used by the pre-commit hook via lint-staged) to skip
// type-aware parsing/rules for fast feedback. `pnpm lint` and CI run the full config.
const noTypecheck = process.env.ESLINT_NO_TYPECHECK === '1';

const tsConfigs = noTypecheck
  ? tseslint.configs.recommended.map((c) => ({ ...c, files: ['**/*.ts', '**/*.tsx'] }))
  : tseslint.configs.recommendedTypeChecked.map((c) => ({
      ...c,
      files: ['**/*.ts', '**/*.tsx'],
      languageOptions: {
        ...c.languageOptions,
        parserOptions: {
          ...c.languageOptions?.parserOptions,
          project: ['./tsconfig.base.json', './apps/*/tsconfig.json', './packages/*/tsconfig.json'],
        },
      },
    }));

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
  js.configs.recommended,
  ...tsConfigs,
  {
    files: ['**/*.ts', '**/*.tsx'],
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
