#!/usr/bin/env bash
# Recreate Cos morning-brief / task dispatch as Hermes cron jobs.
# Does not talk to the live VPS. Run on the host that owns the eve profile.
#
# Default deliver is ntfy-only so this can run on the upgraded VPS before the
# glasses-server fork is cut over. After cutover, pass g2,ntfy.
set -euo pipefail

PROFILE="${1:-eve}"
DELIVER="${2:-ntfy}"

case "$DELIVER" in
  ntfy|g2|g2,ntfy|ntfy,g2) ;;
  *)
    echo "deliver must be ntfy, g2, or g2,ntfy (got: $DELIVER)" >&2
    exit 1
    ;;
esac

if [[ "$DELIVER" == *g2* ]]; then
  echo "g2 deliver needs the hermes-redesign fork on :3141. Do not use it on the live VPS until Oscar says go." >&2
fi

hermes -p "$PROFILE" cron create "daily at 06:30" \
  "Write Oscar's morning brief for the G2. Two lines. Lead with the one thing that matters." \
  --skill g2-notify --deliver "$DELIVER" --continuity

echo "Created the morning brief on profile $PROFILE (deliver: $DELIVER)."
echo "Add more jobs with: hermes -p $PROFILE cron create \"…\" --deliver $DELIVER --continuity"
echo "Glasses chat commands (after cutover): /cron list, /cron pause <id>, /cron resume <id>"
