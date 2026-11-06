# shellcheck shell=bash
# Deploy target interface for scripts/deploy-impl.sh (sourced; defines functions and constants only, runs nothing).
# Target-agnostic on purpose: NO real target is wired in. A real target is added later as one reviewed PR that
# (1) appends its name to DEPLOY_KNOWN_TARGETS and (2) defines `deploy_target_<name>` (dashes -> underscores),
# called as: deploy_target_<name> <env> <sha> /dev/fd/7. It must read the credential ONLY from that path (the
# already-validated open fd), never re-open DEPLOY_CREDENTIALS_FILE, and exit non-zero on any failure.
#
# Interface (env, passed through scripts/deploy.sh's env -i allowlist):
#   DEPLOY_TARGET               target name; unset/empty or "none" = placeholder run (gates only, deploys nothing,
#                               records no staging marker). Anything not in DEPLOY_KNOWN_TARGETS is refused.
#   DEPLOY_CREDENTIALS_FILE     absolute path to the target credential (required for a real target). Must be a
#                               regular, non-symlink file owned by the current user with no group/other bits
#                               (0600/0400), parent dir not group/world-writable. Name/path are checked before
#                               gates; the file is opened onto fd 7 only after gates and confirmation. Contents
#                               are never read by this script or logged. Gates and prisma do not inherit fd 7.
#   DEPLOY_DATABASE_URL_FILE    absolute path to a file holding the production/staging DATABASE_URL (same file
#                               rules). Opened onto fd 8 only after gates and confirmation, read once, then
#                               closed. Only `prisma migrate deploy` sees the URL (env, not argv); never echoed.
#   DEPLOY_CREDENTIALS          refused if set: pass secrets as files, not env values. deploy.sh forwards only
#                               DEPLOY_CREDENTIALS_SET=1, never the value, through env -i.
DEPLOY_KNOWN_TARGETS=(none)

deploy_abort() { echo "ABORT: $*" >&2; exit 1; }

# Secret files are opened ONCE onto a fixed fd and every check and read goes through that fd, so a path swap after
# the open (TOCTOU) cannot change what is validated or read:
#   1. path absolute, not a symlink (lstat), parent dir owned by us or root and not group/world-writable;
#   2. `exec N<path`, then fstat via /proc/self/fd/N (regular file, owner = uid, mode & 077 == 0, non-empty);
#   3. the fd's dev:inode must equal the path's lstat dev:inode (a swap between 1 and 2 is detected);
#   4. contents are read only from fd N. Targets get `/dev/fd/N` (reopens the same inode, not the path).
DEPLOY_CRED_FD=7
DEPLOY_DBURL_FD=8

# $1 = label, $2 = path, $3 = fd number. Leaves the file open on fd $3.
deploy_open_secret_file() {
  local label="$1" f="$2" fd="$3" uid dir dinfo linfo finfo ftype fowner fmode fsize fid
  uid="$(/usr/bin/id -u)"
  [[ "$f" == /* ]] || deploy_abort "$label must be an absolute path"
  [ ! -L "$f" ] || deploy_abort "$label must not be a symlink"
  dir="${f%/*}"; dir="${dir:-/}"
  dinfo="$(/usr/bin/stat -c '%F|%u|%a' -- "$dir" 2>/dev/null)" || deploy_abort "$label parent dir not found"
  [ "${dinfo%%|*}" = directory ] || deploy_abort "$label parent is not a directory"
  dinfo="${dinfo#*|}"
  case "${dinfo%%|*}" in "$uid"|0) ;; *) deploy_abort "$label parent dir not owned by current user or root";; esac
  (( 8#${dinfo#*|} & 8#022 )) && deploy_abort "$label parent dir is group/world-writable"
  # No -L: GNU stat lstats the path. Symlinks were already refused above; comparing this
  # lstat to the fd's fstat still detects a swap between the two checks.
  linfo="$(/usr/bin/stat -c '%d:%i' -- "$f" 2>/dev/null)" || deploy_abort "$label not found"
  eval "exec $fd<\"\$f\"" 2>/dev/null || deploy_abort "$label cannot be opened"
  finfo="$(/usr/bin/stat -L -c '%F|%u|%a|%s|%d:%i' "/proc/self/fd/$fd" 2>/dev/null)" || deploy_abort "$label: fstat failed"
  IFS='|' read -r ftype fowner fmode fsize fid <<< "$finfo"
  case "$ftype" in "regular file"|"regular empty file") ;; *) deploy_abort "$label is not a regular file";; esac
  [ "$fowner" = "$uid" ] || deploy_abort "$label not owned by current user"
  (( 8#$fmode & 8#077 )) && deploy_abort "$label must not be readable by group/other (chmod 600)"
  [ "$fsize" -gt 0 ] || deploy_abort "$label is empty"
  [ "$fid" = "$linfo" ] || deploy_abort "$label changed while being opened"
  return 0
}

# Name/flag validation only. Call before any gate so mistakes fail fast. Secret files are NOT
# opened here: bash fds are inherited by children, so opening before pnpm/gitleaks/audit-gate
# would leak readable handles into those processes.
deploy_validate_target() {
  # deploy.sh forwards only DEPLOY_CREDENTIALS_SET=1 (never the value) when the caller set DEPLOY_CREDENTIALS.
  [ -z "${DEPLOY_CREDENTIALS_SET:-}" ] && [ -z "${DEPLOY_CREDENTIALS:-}" ] \
    || deploy_abort "DEPLOY_CREDENTIALS is not accepted; use DEPLOY_CREDENTIALS_FILE"
  local t="${DEPLOY_TARGET:-none}" k known=0
  [[ "$t" =~ ^[a-z][a-z0-9-]{0,31}$ ]] || deploy_abort "DEPLOY_TARGET must match ^[a-z][a-z0-9-]{0,31}\$"
  for k in "${DEPLOY_KNOWN_TARGETS[@]}"; do [ "$k" = "$t" ] && known=1; done
  [ "$known" = 1 ] || deploy_abort "unknown DEPLOY_TARGET '$t' (known: ${DEPLOY_KNOWN_TARGETS[*]})"
  DEPLOY_TARGET_NAME="$t"
  [ "$t" = none ] && return 0
  declare -F "deploy_target_${t//-/_}" >/dev/null || deploy_abort "DEPLOY_TARGET '$t' has no deploy_target_${t//-/_} function"
  [ -n "${DEPLOY_CREDENTIALS_FILE:-}" ] || deploy_abort "DEPLOY_CREDENTIALS_FILE is required for DEPLOY_TARGET '$t'"
  [[ "$DEPLOY_CREDENTIALS_FILE" == /* ]] || deploy_abort "DEPLOY_CREDENTIALS_FILE must be an absolute path"
  [ -n "${DEPLOY_DATABASE_URL_FILE:-}" ] || deploy_abort "DEPLOY_DATABASE_URL_FILE is required for DEPLOY_TARGET '$t'"
  [[ "$DEPLOY_DATABASE_URL_FILE" == /* ]] || deploy_abort "DEPLOY_DATABASE_URL_FILE must be an absolute path"
  return 0
}

# Open secret files only after gates and confirmation. Close the DB URL fd immediately after the
# single read so later children (prisma, the target) cannot inherit it.
deploy_prepare_secrets() {
  [ "$DEPLOY_TARGET_NAME" = none ] && return 0
  deploy_open_secret_file DEPLOY_CREDENTIALS_FILE "$DEPLOY_CREDENTIALS_FILE" "$DEPLOY_CRED_FD"
  deploy_open_secret_file DEPLOY_DATABASE_URL_FILE "$DEPLOY_DATABASE_URL_FILE" "$DEPLOY_DBURL_FD"
  DEPLOY_DB_URL_VALUE=""
  IFS= read -r DEPLOY_DB_URL_VALUE <&"$DEPLOY_DBURL_FD" || true
  exec 8<&-
  [[ "$DEPLOY_DB_URL_VALUE" =~ ^postgres(ql)?://[^[:space:]]+$ ]] || deploy_abort "DEPLOY_DATABASE_URL_FILE does not hold a postgres:// URL"
  return 0
}

# prisma migrate deploy, once, before rollout. $1 = PATH for pnpm. The URL only reaches prisma's env (not argv).
# Close credential fd 7 in the child so prisma never sees the deploy credential.
deploy_migrate() {
  echo "==> prisma migrate deploy"
  DATABASE_URL="$DEPLOY_DB_URL_VALUE" PATH="$1" pnpm --filter @meetops/database exec prisma migrate deploy 7<&- \
    || deploy_abort "prisma migrate deploy failed; nothing was rolled out"
  unset DEPLOY_DB_URL_VALUE
}

# Order matters: migrate -> rollout -> (staging only) marker. A marker is written ONLY after a real rollout
# succeeds, so the production gate can never be satisfied by a placeholder or failed run.
# $1 env, $2 sha, $3 PATH for tools, $4 name of the function that records the staging marker.
deploy_run() {
  local env="$1" sha="$2" path="$3" record="$4"
  if [ "$DEPLOY_TARGET_NAME" = none ]; then
    echo "PLACEHOLDER: DEPLOY_TARGET is unset/none, so nothing was deployed and no migration ran."
    echo "Would deploy ghcr.io/iakash22/meetops-platform/{api,worker,web,realtime}:sha-$sha to $env."
    echo "Nothing was deployed, so no staging marker is recorded."
    return 0
  fi
  deploy_prepare_secrets
  deploy_migrate "$path"
  echo "==> rollout via target '$DEPLOY_TARGET_NAME'"
  PATH="$path" "deploy_target_${DEPLOY_TARGET_NAME//-/_}" "$env" "$sha" "/dev/fd/$DEPLOY_CRED_FD" \
    || deploy_abort "rollout via '$DEPLOY_TARGET_NAME' failed; no staging marker recorded"
  if [ "$env" = staging ]; then "$record"; fi
  echo "Deployed sha-$sha to $env via $DEPLOY_TARGET_NAME."
}
