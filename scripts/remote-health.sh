#!/usr/bin/env bash
# Reachability checks for the upgraded VPS. Never prints tokens or topic names.
set -euo pipefail

PAIRING_HOST="${COS_PAIRING_HOST:-100.87.43.24}"
PAIRING_PORT="${COS_PAIRING_PORT:-3141}"
NTFY_PORT="${NTFY_PORT:-2586}"
PROFILE="${HERMES_PROFILE:-eve}"
HERMES_HOME="${HERMES_HOME:-$HOME/.hermes}"
ENV_FILE="${NTFY_ENV_FILE:-$HERMES_HOME/profiles/$PROFILE/ntfy.env}"

fail=0

check() {
  local name="$1"
  shift
  if "$@"; then
    echo "ok  $name"
  else
    echo "fail  $name"
    fail=1
  fi
}

check "tailscale ipv4" bash -c 'ip=$(tailscale ip -4 | head -n1); [[ -n "$ip" ]]'
check "glasses /api/health" curl -fsS --max-time 5 "http://${PAIRING_HOST}:${PAIRING_PORT}/api/health" >/dev/null

if [[ -f "$ENV_FILE" ]]; then
  # shellcheck disable=SC1090
  set -a
  source "$ENV_FILE"
  set +a
fi

NTFY_URL="${NTFY_SERVER_URL:-http://${PAIRING_HOST}:${NTFY_PORT}}"
check "ntfy /v1/health" curl -fsS --max-time 5 "${NTFY_URL}/v1/health" >/dev/null

if command -v hermes >/dev/null 2>&1; then
  check "hermes profile ${PROFILE}" hermes -p "$PROFILE" status >/dev/null
else
  echo "skip  hermes CLI not on PATH"
fi

exit "$fail"
