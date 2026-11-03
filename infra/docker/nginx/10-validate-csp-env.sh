#!/bin/sh
# P9 R20: refuse to start nginx when a CSP origin would weaken connect-src/media-src.
# Each of CSP_API_ORIGIN, CSP_REALTIME_ORIGIN, CSP_STORAGE_ORIGIN must be set, non-blank, and every
# space-separated source must be a scheme://host[:port] origin without any '*' wildcard.
# CSP_REPORT_URL is optional; when set it must be an https:// URL (http://localhost allowed for local runs).
# Production (CSP_UPGRADE_INSECURE=on, the image default) also requires every origin to be https:// or wss://;
# only the plain-http local stack (CSP_UPGRADE_INSECURE=off) may use http:// or ws://.
set -euf

case "${CSP_UPGRADE_INSECURE-on}" in
  on | off) ;;
  *) echo "10-validate-csp-env: CSP_UPGRADE_INSECURE must be on or off" >&2; exit 1 ;;
esac
production=${CSP_UPGRADE_INSECURE-on}

fail() {
  echo "10-validate-csp-env: $1" >&2
  exit 1
}

for name in CSP_API_ORIGIN CSP_REALTIME_ORIGIN CSP_STORAGE_ORIGIN; do
  eval "value=\${$name-}"
  trimmed=$(printf '%s' "$value" | tr -d ' \t')
  [ -n "$trimmed" ] || fail "$name is empty"
  for src in $value; do
    case "$src" in
      *'*'*) fail "$name must not contain a '*' wildcard" ;;
      *\;* | *\"* | *\'*) fail "$name contains a forbidden character" ;;
      https://?* | wss://?*) ;;
      http://?* | ws://?*)
        [ "$production" = off ] || fail "$name contains '$src', but CSP_UPGRADE_INSECURE=on (the production default) requires https:// or wss:// origins: upgrade-insecure-requests would rewrite it and the browser would block it. Fix: set $name to https:// / wss:// origins, or for a local plain-http stack set CSP_UPGRADE_INSECURE=off."
        ;;
      *) fail "$name entries must be scheme://host[:port] origins" ;;
    esac
    rest=${src#*://}
    case "$rest" in
      */?* | *\?* | *\#*) fail "$name entries must be origins without a path, query or fragment" ;;
    esac
  done
done

report=${CSP_REPORT_URL-}
if [ -n "$report" ]; then
  case "$report" in
    *'*'* | *\"* | *\;* | *' '*) fail "CSP_REPORT_URL contains a forbidden character" ;;
    https://?* | http://localhost:* | http://localhost/* | http://127.0.0.1:*) ;;
    *) fail "CSP_REPORT_URL must be an https:// URL" ;;
  esac
fi

# /socket.io proxy: both values are pasted into nginx directives, so allow only the exact shapes nginx needs
# (no spaces, ';', quotes, braces or paths that could add directives).
single_line() { [ "$(printf '%s' "$1" | wc -l)" -eq 0 ] || fail "$2 must be a single line"; }
upstream=${REALTIME_UPSTREAM-http://realtime:4001}
single_line "$upstream" REALTIME_UPSTREAM
printf '%s' "$upstream" | grep -Eq '^https?://[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?(:[0-9]{1,5})?$' ||
  fail "REALTIME_UPSTREAM must be http(s)://host[:port] (no path, query or other characters)"
resolver=${NGINX_RESOLVER-127.0.0.11}
single_line "$resolver" NGINX_RESOLVER
printf '%s' "$resolver" | grep -Eq '^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$' ||
  fail "NGINX_RESOLVER must be a single IPv4 address or hostname (127.0.0.11 is Docker's DNS: Docker only)"
