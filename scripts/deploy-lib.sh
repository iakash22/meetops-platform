# shellcheck shell=bash
# Deploy target interface for scripts/deploy-impl.sh (sourced; defines functions and constants only, runs nothing).
# Target-agnostic on purpose: NO real target is wired in. A real target is added later as one reviewed PR that
# (1) appends its name to DEPLOY_KNOWN_TARGETS and (2) defines `deploy_target_<name>` (dashes -> underscores),
# called as: deploy_target_<name> <env> <sha> <credentials-file>. It must exit non-zero on any failure.
#
# Interface (env, passed through scripts/deploy.sh's env -i allowlist):
#   DEPLOY_TARGET               target name; unset/empty or "none" = placeholder run (gates only, deploys nothing,
#                               records no staging marker). Anything not in DEPLOY_KNOWN_TARGETS is refused.
#   DEPLOY_CREDENTIALS_FILE     absolute path to the target credential (required for a real target). Must be a
#                               regular, non-symlink file owned by the current user with no group/other bits
#                               (0600/0400). Its contents are never read by this script or logged.
#   DEPLOY_DATABASE_URL_FILE    absolute path to a file holding the production/staging DATABASE_URL (same file
#                               rules). Read only into the env of `prisma migrate deploy`; never echoed.
#   DEPLOY_CREDENTIALS          refused if set: pass secrets as files, not env values.
DEPLOY_KNOWN_TARGETS=(none)

deploy_abort() { echo "ABORT: $*" >&2; exit 1; }

# $1 = label, $2 = path. Owner = current uid, regular non-symlink file, mode & 077 == 0.
deploy_check_secret_file() {
  local label="$1" f="$2" info
  [[ "$f" == /* ]] || deploy_abort "$label must be an absolute path"
  [ ! -L "$f" ] || deploy_abort "$label must not be a symlink"
  info="$(/usr/bin/stat -c '%F|%u|%a' "$f" 2>/dev/null)" || deploy_abort "$label not found"
  case "${info%%|*}" in "regular file"|"regular empty file") ;; *) deploy_abort "$label is not a regular file";; esac
  info="${info#*|}"
  [ "${info%%|*}" = "$(/usr/bin/id -u)" ] || deploy_abort "$label not owned by current user"
  (( 8#${info#*|} & 8#077 )) && deploy_abort "$label must not be readable by group/other (chmod 600)"
  [ -s "$f" ] || deploy_abort "$label is empty"
  return 0
}

# Validates the interface and sets DEPLOY_TARGET_NAME. Call before any gate so mistakes fail fast.
deploy_validate_target() {
  [ -z "${DEPLOY_CREDENTIALS:-}" ] || deploy_abort "DEPLOY_CREDENTIALS is not accepted; use DEPLOY_CREDENTIALS_FILE"
  local t="${DEPLOY_TARGET:-none}" k known=0
  [[ "$t" =~ ^[a-z][a-z0-9-]{0,31}$ ]] || deploy_abort "DEPLOY_TARGET must match ^[a-z][a-z0-9-]{0,31}\$"
  for k in "${DEPLOY_KNOWN_TARGETS[@]}"; do [ "$k" = "$t" ] && known=1; done
  [ "$known" = 1 ] || deploy_abort "unknown DEPLOY_TARGET '$t' (known: ${DEPLOY_KNOWN_TARGETS[*]})"
  DEPLOY_TARGET_NAME="$t"
  [ "$t" = none ] && return 0
  declare -F "deploy_target_${t//-/_}" >/dev/null || deploy_abort "DEPLOY_TARGET '$t' has no deploy_target_${t//-/_} function"
  [ -n "${DEPLOY_CREDENTIALS_FILE:-}" ] || deploy_abort "DEPLOY_CREDENTIALS_FILE is required for DEPLOY_TARGET '$t'"
  deploy_check_secret_file DEPLOY_CREDENTIALS_FILE "$DEPLOY_CREDENTIALS_FILE"
  [ -n "${DEPLOY_DATABASE_URL_FILE:-}" ] || deploy_abort "DEPLOY_DATABASE_URL_FILE is required for DEPLOY_TARGET '$t'"
  deploy_check_secret_file DEPLOY_DATABASE_URL_FILE "$DEPLOY_DATABASE_URL_FILE"
  local url; IFS= read -r url < "$DEPLOY_DATABASE_URL_FILE" || true
  [[ "$url" =~ ^postgres(ql)?://[^[:space:]]+$ ]] || deploy_abort "DEPLOY_DATABASE_URL_FILE does not hold a postgres:// URL"
  return 0
}

# prisma migrate deploy, once, before rollout. $1 = PATH for pnpm. The URL only reaches prisma's env.
deploy_migrate() {
  local url; IFS= read -r url < "$DEPLOY_DATABASE_URL_FILE"
  echo "==> prisma migrate deploy"
  DATABASE_URL="$url" PATH="$1" pnpm --filter @meetops/database exec prisma migrate deploy \
    || deploy_abort "prisma migrate deploy failed; nothing was rolled out"
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
  deploy_migrate "$path"
  echo "==> rollout via target '$DEPLOY_TARGET_NAME'"
  PATH="$path" "deploy_target_${DEPLOY_TARGET_NAME//-/_}" "$env" "$sha" "$DEPLOY_CREDENTIALS_FILE" \
    || deploy_abort "rollout via '$DEPLOY_TARGET_NAME' failed; no staging marker recorded"
  if [ "$env" = staging ]; then "$record"; fi
  echo "Deployed sha-$sha to $env via $DEPLOY_TARGET_NAME."
}
