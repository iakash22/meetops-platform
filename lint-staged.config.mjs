// lint-staged config for the fast pre-commit hook (.husky/pre-commit sets ESLINT_NO_TYPECHECK=1).
// On merge commits the staged set is every file brought in from the other branch, which was
// already formatted and linted there; re-running prettier --write on it rewrites unrelated code
// (and can move eslint-disable-next-line comments away from their target line). So during a
// merge only the non-type-aware eslint pass runs; pre-push and CI still run the full checks.
import { execFileSync } from 'node:child_process';

const merging = (() => {
  try {
    execFileSync('git', ['rev-parse', '-q', '--verify', 'MERGE_HEAD'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

const code = ['eslint --fix --no-warn-ignored'];

export default merging
  ? { '*.{ts,tsx,js,jsx,cjs,mjs}': code }
  : {
      '*.{ts,tsx,js,jsx,cjs,mjs}': ['prettier --write', ...code],
      '*.{md,json,yml,yaml}': ['prettier --write'],
    };
