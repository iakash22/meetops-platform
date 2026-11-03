#!/bin/bash -p
# GUARD (must stay first): refuse unless started by scripts/deploy.sh, which sets
# MEETOPS_DEPLOY_WRAPPED=1 through env -i and runs bash -p. Without -p, bash may have imported
# exported functions (e.g. BASH_FUNC_exit%%), so this guard uses only keywords (case, [[) and
# path-qualified commands (/usr/bin/printf, /bin/kill), which never resolve to functions. It
# catches accidental direct runs; the sentinel is not a secret.
case "$-" in *p*) ;; *)
  /usr/bin/printf 'ABORT: run scripts/deploy.sh, not deploy-impl.sh (bash -p required)\n' >&2
  /bin/kill -KILL $$ ;; esac
[[ "${MEETOPS_DEPLOY_WRAPPED:-}" == 1 ]] || {
  /usr/bin/printf 'ABORT: run scripts/deploy.sh, not deploy-impl.sh (wrapper sentinel missing)\n' >&2
  /bin/kill -KILL $$; }
# Deploy implementation. Do NOT run directly: use scripts/deploy.sh, which scrubs the env and
# execs this file with /bin/bash --norc --noprofile -p (PLACEHOLDER: no deploy target yet).
# Usage: scripts/deploy.sh [--non-interactive] <staging|production> [image-sha]
# Requires an interactive TTY confirmation (read from /dev/tty) for every environment.
# Non-interactive runs must pass --non-interactive AND set DEPLOY_CONFIRM="deploy <env>".
# Production requires a prior successful staging deploy of the same sha (staging gate), recorded
# as a marker in a FIXED state dir: <passwd home of the current uid>/.local/state/meetops-deploy.
# The dir is NOT configurable via env (DEPLOY_STATE_DIR/XDG_STATE_HOME/HOME are ignored), so a
# caller cannot point the gate at a forged marker. Marker must be a regular non-symlink file owned
# by the current user, in a non-symlink dir owned by the user that is not group/world-writable.
# Threat model: the gate protects against accidents and misconfiguration (a stray
# DEPLOY_STATE_DIR/HOME/PATH, a forged marker from another local user, an exported bash function
# or BASH_ENV). It is NOT a security boundary against a hostile caller who controls the env or the
# process (LD_PRELOAD, ptrace, a modified checkout) or who runs as the same user (can write the
# marker). Real enforcement belongs to the deploy target (e.g. GitHub environment protection).
# DEPLOY_PREFLIGHT_ONLY=1 (tests): stop with exit 0 right after the pre-gate checks, before any
# gate or deploy; only in that mode is DEPLOY_TEST_STATE_DIR honoured.
# [image-sha] must be the full 40-char HEAD sha (default: HEAD).
# Aborts unless `pnpm local-gates`, gitleaks and scripts/audit-gate.mjs all pass on a clean tree.
# PATH is reset first so no caller-supplied binary (fake getent/id/stat/git) can influence the
# staging gate; trust-critical tools are also invoked by absolute path. The later gate tools
# (pnpm, gitleaks, node) live outside /usr/bin and run with GATE_PATH (see below).
# Residual race: the marker is checked with one `stat` call (type, owner, mode together) after the
# path walk; a same-user process could still swap a path component between the two. That is
# within the documented threat model (same-user attackers are out of scope).
PATH=/usr/bin:/bin; export PATH
set -euo pipefail
for _b in getent id stat git cut date mkdir chmod dirname; do
  [ -x "/usr/bin/$_b" ] || { echo "ABORT: /usr/bin/$_b missing" >&2; exit 1; }
done
GETENT=/usr/bin/getent; ID=/usr/bin/id; STAT=/usr/bin/stat; GIT=/usr/bin/git
cd "$(/usr/bin/dirname "$0")/.."

NON_INTERACTIVE=0
if [ "${1:-}" = "--non-interactive" ]; then NON_INTERACTIVE=1; shift; fi
ENV_NAME="${1:-}"
case "$ENV_NAME" in staging|production) ;; *)
  echo "Usage: scripts/deploy.sh [--non-interactive] <staging|production> [image-sha]" >&2; exit 2;; esac
abort() { echo "ABORT: $*" >&2; exit 1; }
MY_UID="$("$ID" -u)"
PASSWD_HOME="$("$GETENT" passwd "$MY_UID" | /usr/bin/cut -d: -f6)"
[ -n "$PASSWD_HOME" ] || abort "cannot resolve home dir for uid $MY_UID"
GATE_PATH="/usr/local/bin:/usr/bin:/bin:$PASSWD_HOME/.local/bin"
STATE_DIR="$PASSWD_HOME/.local/state/meetops-deploy"
PREFLIGHT_ONLY=0
if [ "${DEPLOY_PREFLIGHT_ONLY:-}" = 1 ]; then
  PREFLIGHT_ONLY=1
  [ -n "${DEPLOY_TEST_STATE_DIR:-}" ] && STATE_DIR="$DEPLOY_TEST_STATE_DIR"
fi
check_state_dir() {
  [[ "$STATE_DIR" == /* ]] || abort "staging gate: state dir must be absolute"
  local p="" part
  IFS=/ read -ra parts <<< "${STATE_DIR#/}"
  for part in "${parts[@]}"; do
    [ -n "$part" ] || continue
    p="$p/$part"
    [ ! -L "$p" ] || abort "staging gate: symlink in state dir path ($p)"
  done
  local info; info="$("$STAT" -c '%F|%u|%a' "$STATE_DIR" 2>/dev/null)" || abort "staging gate: state dir $STATE_DIR missing or a symlink"
  [ "${info%%|*}" = directory ] || abort "staging gate: state dir $STATE_DIR missing or a symlink"
  info="${info#*|}"
  [ "${info%%|*}" = "$MY_UID" ] || abort "staging gate: state dir not owned by current user"
  (( 8#${info#*|} & 8#022 )) && abort "staging gate: state dir is group/world-writable"
  return 0
}
HEAD_SHA="$("$GIT" rev-parse HEAD)"
SHA="${2:-$HEAD_SHA}"
[[ "$SHA" =~ ^[0-9a-f]{40}$ ]] || abort "sha must be exactly 40 lowercase hex characters"
[ "$SHA" = "$HEAD_SHA" ] || abort "sha $SHA does not match HEAD $HEAD_SHA; check out that commit first"
if [ "$NON_INTERACTIVE" = 1 ]; then
  [ "${DEPLOY_CONFIRM:-}" = "deploy $ENV_NAME" ] || abort "--non-interactive requires DEPLOY_CONFIRM='deploy $ENV_NAME'"
else
  [ -t 0 ] || abort "interactive terminal required (stdin is not a TTY); use --non-interactive explicitly"
fi
if [ "$ENV_NAME" = production ]; then
  check_state_dir
  MARKER="$STATE_DIR/staging-$SHA"
  # One lstat-style call (no -L): a symlink reports "symbolic link", so type and owner are atomic.
  MINFO="$("$STAT" -c '%F|%u' "$MARKER" 2>/dev/null)" || MINFO=""
  case "$MINFO" in "regular file|"*|"regular empty file|"*) ;; *)
    abort "staging gate: sha $SHA has not been deployed to staging (no regular marker file)";; esac
  [ "${MINFO#*|}" = "$MY_UID" ] || abort "staging gate: marker not owned by current user"
fi
if [ "$PREFLIGHT_ONLY" = 1 ]; then echo "PREFLIGHT OK"; exit 0; fi
[ -z "$("$GIT" status --porcelain)" ] || abort "working tree is dirty"

echo "==> gate: pnpm local-gates"
PATH="$GATE_PATH" pnpm local-gates || abort "pnpm local-gates failed"
echo "==> gate: gitleaks"
PATH="$GATE_PATH" gitleaks detect --source . --redact --no-banner || abort "gitleaks found leaks"
echo "==> gate: audit-gate"
/usr/bin/env -u AUDIT_GATE_NOW PATH="$GATE_PATH" node scripts/audit-gate.mjs || abort "audit-gate failed"

if [ "$NON_INTERACTIVE" = 0 ]; then
  [ -t 0 ] || abort "interactive terminal required"
  printf "Deploy sha-%s to %s? Type 'deploy %s': " "$SHA" "$ENV_NAME" "$ENV_NAME" > /dev/tty
  IFS= read -r ans < /dev/tty || abort "no confirmation read"
  [ "$ans" = "deploy $ENV_NAME" ] || abort "not confirmed"
fi

echo "All gates passed."
echo "PLACEHOLDER: would deploy ghcr.io/iakash22/meetops-platform/{api,worker,web,realtime}:sha-$SHA to $ENV_NAME."
echo "Needed when a real target exists (provide via env/secret manager, never in the repo):"
echo "  DEPLOY_TARGET       deploy endpoint (cluster API, host, or platform app id)"
echo "  DEPLOY_CREDENTIALS  deploy credential (short-lived/OIDC preferred)"
echo "  DATABASE_URL        to run 'prisma migrate deploy' before rollout"
echo "Nothing was deployed, so no staging marker is recorded."
# When a real target exists, call record_staging ONLY after the deploy command succeeds:
#   real_deploy_command && { [ "$ENV_NAME" = staging ] && record_staging; }
record_staging() {
  umask 077
  local d="$PASSWD_HOME" sub
  for sub in .local state meetops-deploy; do
    d="$d/$sub"; [ -L "$d" ] && abort "refusing symlink $d"
    [ -d "$d" ] || /usr/bin/mkdir "$d"
  done
  /usr/bin/chmod 700 "$STATE_DIR"; check_state_dir
  /usr/bin/date -u +%FT%TZ > "$STATE_DIR/staging-$SHA"
  echo "Recorded staging gate for $SHA in $STATE_DIR."
}
