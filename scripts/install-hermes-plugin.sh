#!/usr/bin/env bash
set -euo pipefail

PROFILE="${1:-eve}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/hermes-plugin/g2"
DEST="${HERMES_HOME:-$HOME/.hermes}/profiles/$PROFILE/plugins/platforms/g2"

if [[ ! -d "$SRC" ]]; then
  echo "missing plugin source: $SRC" >&2
  exit 1
fi

mkdir -p "$(dirname "$DEST")"
if [[ -e "$DEST" || -L "$DEST" ]]; then
  rm -rf "$DEST"
fi
ln -s "$SRC" "$DEST"
echo "installed g2 plugin → $DEST"
echo "next: hermes -p $PROFILE plugins enable g2-platform"
