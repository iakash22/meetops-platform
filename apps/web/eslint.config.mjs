// apps/web reuses the monorepo ESLint config (type-aware via the root setup).
import rootConfig, { appBoundaryPatterns, boundaryImports, UI_CONTRACTS_PATHS } from '../../eslint.config.mjs';

export default [
  ...rootConfig,
  { ignores: ['dist/**', 'eslint.config.mjs', 'postcss.config.js'] },
  {
    files: ['**/*.ts', '**/*.tsx'],
    rules: { '@typescript-eslint/no-restricted-imports': boundaryImports({ patterns: appBoundaryPatterns('web') }) },
  },
  {
    // Shipped bundle: no runtime import of the contracts main entry (TypeBox).
    files: ['src/**/*.ts', 'src/**/*.tsx'],
    rules: {
      '@typescript-eslint/no-restricted-imports': boundaryImports({
        patterns: appBoundaryPatterns('web'),
        paths: UI_CONTRACTS_PATHS,
      }),
    },
  },
];
