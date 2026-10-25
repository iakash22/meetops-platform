// apps/desktop reuses the monorepo ESLint config (type-aware, boundary rules).
import rootConfig, {
  appBoundaryPatterns,
  boundaryImports,
  UI_CONTRACTS_PATHS,
} from '../../eslint.config.mjs';

export default [
  { ignores: ['dist/**', 'src-tauri/**', 'eslint.config.mjs'] },
  ...rootConfig,
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
    // Desktop must not import other apps (root APP_NAMES); other apps must not import desktop.
    files: ['**/*.ts', '**/*.tsx'],
    rules: {
      '@typescript-eslint/no-restricted-imports': boundaryImports({
        patterns: appBoundaryPatterns('desktop'),
      }),
    },
  },
  {
    // Shipped webview bundle: no runtime import of the contracts main entry (TypeBox).
    files: ['src/**/*.ts', 'src/**/*.tsx'],
    rules: {
      '@typescript-eslint/no-restricted-imports': boundaryImports({
        patterns: appBoundaryPatterns('desktop'),
        paths: UI_CONTRACTS_PATHS,
      }),
    },
  },
];
