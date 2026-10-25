// apps/mobile reuses the monorepo ESLint config and adds the mobile import boundaries (see README "Contracts import rule").
import rootConfig, {
  appBoundaryPatterns,
  boundaryImports,
  UI_CONTRACTS_PATHS,
} from '../../eslint.config.mjs';

/** Mobile is a client bundle: no server-only packages (logger is pino, Node-only). */
const SERVER_PACKAGE_PATTERNS = [
  {
    group: [
      'database',
      'ai-core',
      'integrations',
      'queue',
      'storage',
      'media-core',
      'notifications',
      'logger',
    ].flatMap((p) => [`@meetops/${p}`, `@meetops/${p}/**`]),
    message: 'Mobile must not import server-only packages; go through the API contracts.',
  },
];
const mobilePatterns = [...appBoundaryPatterns('mobile'), ...SERVER_PACKAGE_PATTERNS];

export default [
  ...rootConfig,
  { ignores: ['.expo/**', 'dist/**'] },
  {
    files: ['**/*.ts', '**/*.tsx'],
    rules: {
      '@typescript-eslint/no-restricted-imports': boundaryImports({ patterns: mobilePatterns }),
    },
  },
  {
    // Shipped bundle: no runtime import of the contracts main entry (TypeBox).
    files: ['app/**/*.ts', 'app/**/*.tsx', 'src/**/*.ts', 'src/**/*.tsx'],
    rules: {
      '@typescript-eslint/no-restricted-imports': boundaryImports({
        patterns: mobilePatterns,
        paths: UI_CONTRACTS_PATHS,
      }),
    },
  },
];
