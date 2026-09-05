# Tier 1 attention channel (iPhone)

Oscar's daily driver is an iPhone. The Even Realities app keeps Hub WebViews
running while the phone is locked, and it mirrors phone notifications onto the
G2 as popups even when another glasses app is in front.

Hermes therefore delivers unsolicited briefs through a phone notification
channel. No glasses-server code is required for this path.

## Recommended: self-hosted ntfy

1. Run ntfy on the VPS, reachable only over Tailscale.
2. In the Eve Hermes profile `.env`:

```
NTFY_SERVER_URL=https://<tailscale-ntfy-host>
NTFY_TOPIC=<random-unlisted-topic>
NTFY_PUBLISH_TOPIC=<same-as-topic>
NTFY_TOKEN=<read-write-token>
NTFY_HOME_CHANNEL=<same-as-topic>
```

Omit `NTFY_ALLOWED_USERS` so the topic is outbound-only (cron/alerts, no inbound
commands).

3. On the iPhone: install ntfy, subscribe to the topic, enable notifications.
4. In the Even app: Settings → Notification → enable ntfy, popup mode ON.

## Alternative: Telegram

Use Telegram if you want to reply from the phone thread. Same Even notification
mirroring applies.

## Skill

Attach a `g2-notify` skill to every job that delivers to ntfy:

- at most two lines
- lead with the ask
- `[SILENT]` when there is nothing to say
- no markdown

## First job

```bash
hermes -p eve cron create "daily at 06:30" \
  "Write Oscar's morning brief for the G2. Two lines. Lead with the one thing that matters." \
  --skill g2-notify --deliver ntfy --continuity
```

Confirm the popup appears on the glasses while Navigate (or any other app) is
in front. That is the attention layer.
