// apps/web reuses the monorepo ESLint config (type-aware via the root setup).
import rootConfig from '../../eslint.config.mjs';

export default [...rootConfig, { ignores: ['dist/**', 'eslint.config.mjs', 'postcss.config.js'] }];
