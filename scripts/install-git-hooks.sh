#!/usr/bin/env sh
# Enables the gitleaks pre-commit hook alongside husky's lint-staged hook.
# Husky owns core.hooksPath (.husky/_), so we chain from .husky/pre-commit
# in the local checkout instead of replacing it.
set -e
root="$(git rev-parse --show-toplevel)"
hook="$root/.husky/pre-commit"
line='sh scripts/hooks/pre-commit'
if [ -f "$hook" ] && grep -qF "$line" "$hook"; then
  echo "gitleaks hook already wired into .husky/pre-commit"
  exit 0
fi
printf '%s\n%s\n' "$line" "$(cat "$hook" 2>/dev/null || echo 'pnpm lint-staged')" > "$hook"
chmod +x "$hook"
echo "Wired gitleaks into .husky/pre-commit. Commit that change to enable it for everyone."
