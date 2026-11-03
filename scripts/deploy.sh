#!/bin/sh
# Manual deploy entrypoint. Run it directly (scripts/deploy.sh ...), never via `bash scripts/deploy.sh`.
# Usage: scripts/deploy.sh [--non-interactive] <staging|production> [image-sha]
# Scrubs the caller's environment (exported functions, BASH_ENV, PATH, LD_*, ...) and execs
# scripts/deploy-impl.sh with /bin/bash --norc --noprofile -p and an allowlisted env only.
# Threat model: see deploy-impl.sh. This guards against accidents and misconfiguration, not against
# a hostile caller who controls the env/process (LD_PRELOAD) or runs as the same user.
set -eu
uid=$(/usr/bin/id -u)
home=$(/usr/bin/getent passwd "$uid" | /usr/bin/cut -d: -f6)
[ -n "$home" ] || { echo "ABORT: cannot resolve home dir for uid $uid" >&2; exit 1; }
case "$0" in */*) dir=${0%/*} ;; *) echo "ABORT: run scripts/deploy.sh by path" >&2; exit 1 ;; esac
exec /usr/bin/env -i PATH=/usr/bin:/bin HOME="$home" TERM="${TERM:-dumb}" \
  COREPACK_HOME="$home/.cache/corepack" \
  DEPLOY_CONFIRM="${DEPLOY_CONFIRM:-}" \
  DEPLOY_PREFLIGHT_ONLY="${DEPLOY_PREFLIGHT_ONLY:-}" \
  DEPLOY_TEST_STATE_DIR="${DEPLOY_TEST_STATE_DIR:-}" \
  MEETOPS_DEPLOY_WRAPPED=1 \
  /bin/bash --norc --noprofile -p "$dir/deploy-impl.sh" "$@"
