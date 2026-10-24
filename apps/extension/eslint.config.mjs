import root, { appBoundaryPatterns, boundaryImports, UI_CONTRACTS_PATHS } from '../../eslint.config.mjs';

export default [
  { ignores: ['.wxt/**', '.output/**', 'dist/**'] },
  ...root,
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      parserOptions: {
        projectService: false,
        project: ['./tsconfig.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: ['**/*.ts', '**/*.tsx'],
    rules: { '@typescript-eslint/no-restricted-imports': boundaryImports({ patterns: appBoundaryPatterns('extension') }) },
  },
  {
    // Shipped bundles: no runtime import of the contracts main entry (TypeBox).
    files: ['src/**/*.ts', 'src/**/*.tsx', 'entrypoints/**/*.ts', 'entrypoints/**/*.tsx'],
    // Allowlisted: src/lib/auth/validate.ts is the single background-only module that validates ADR-005 messages
    // with the contracts TypeBox schemas (see its header). TODO(architecture): revisit if contracts ships a light
    // validator entry, then drop this ignore.
    ignores: ['src/lib/auth/validate.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': boundaryImports({
        patterns: appBoundaryPatterns('extension'),
        paths: UI_CONTRACTS_PATHS,
      }),
    },
  },
];
