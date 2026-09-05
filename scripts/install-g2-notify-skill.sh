#!/usr/bin/env bash
# Link the g2-notify skill into a Hermes profile. Safe to run on the live VPS
# without deploying this fork's Node server.
set -euo pipefail

PROFILE="${1:-eve}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/hermes-plugin/skills/g2-notify"
DEST="${HERMES_HOME:-$HOME/.hermes}/profiles/$PROFILE/skills/g2-notify"

if [[ ! -f "$SRC/SKILL.md" ]]; then
  echo "missing skill source: $SRC/SKILL.md" >&2
  exit 1
fi

mkdir -p "$(dirname "$DEST")"
if [[ -e "$DEST" || -L "$DEST" ]]; then
  rm -rf "$DEST"
fi
ln -s "$SRC" "$DEST"
echo "installed g2-notify → $DEST"
echo "attach it with: hermes -p $PROFILE cron create … --skill g2-notify --deliver ntfy"
