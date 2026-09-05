#!/usr/bin/env bash
# Recreate Cos morning-brief / task dispatch as Hermes cron jobs.
# Does not talk to the live VPS. Run on the host that owns the eve profile.
set -euo pipefail

PROFILE="${1:-eve}"

hermes -p "$PROFILE" cron create "daily at 06:30" \
  "Write Oscar's morning brief for the G2. Two lines. Lead with the one thing that matters." \
  --skill g2-notify --deliver "g2,ntfy" --continuity

echo "Created the morning brief on profile $PROFILE."
echo "Add more jobs with: hermes -p $PROFILE cron create \"…\" --deliver g2,ntfy --continuity"
echo "Glasses chat commands: /cron list, /cron pause <id>, /cron resume <id>"
