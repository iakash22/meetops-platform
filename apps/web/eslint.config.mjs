// apps/web ESLint config: reuse the monorepo config but type-check against
// this app's tsconfig (Bundler resolution + "@/" alias). The root config lists
// tsconfig.base.json first, which resolves web files with NodeNext and no alias,
// turning imported types into `error`/`any` and producing false positives.
import rootConfig from '../../eslint.config.mjs';
import { fileURLToPath } from 'node:url';

const tsconfigRootDir = fileURLToPath(new URL('.', import.meta.url));

export default [
  ...rootConfig,
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      parserOptions: { project: ['./tsconfig.json'], tsconfigRootDir }
    }
  },
  { ignores: ['dist/**', 'eslint.config.mjs', 'postcss.config.js'] }
];
