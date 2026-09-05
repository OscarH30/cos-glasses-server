# Tier 1 attention channel (iPhone)

Oscar's daily driver is an iPhone. The Even Realities app keeps Hub WebViews
running while the phone is locked, and it mirrors phone notifications onto the
G2 as popups even when another glasses app is in front.

Hermes therefore delivers unsolicited briefs through a phone notification
channel. **No glasses-server deploy is required for this path.** It can go on
the upgraded VPS today.

## Add now (upgraded VPS)

Run these on the VPS as the Hermes user (`cos`). They do not replace
`@gotcos/glasses-server@6.44.4` or the Ollama shim.

```bash
# 1. ntfy, Tailscale IPv4 only — never binds 0.0.0.0
./scripts/install-ntfy-tailscale.sh

# 2. two-line G2 notification skill
./scripts/install-g2-notify-skill.sh eve

# 3. morning brief over ntfy (not g2 — that waits for fork cutover)
./scripts/bootstrap-jobs.sh eve ntfy

# 4. reachability; does not print tokens or the topic
./scripts/remote-health.sh
```

`install-ntfy-tailscale.sh` writes Hermes vars to
`~/.hermes/profiles/eve/ntfy.env` (mode 0600) and does not print them. Append
that file to the eve profile `.env`. Omit `NTFY_ALLOWED_USERS` so the topic is
outbound-only (cron/alerts, no inbound commands).

Then on the iPhone:

1. Install ntfy and subscribe to the topic in that env file.
2. Even app → Settings → Notification → enable ntfy, popup mode ON.

Confirm a popup on the glasses while Navigate (or any other app) is in front.

## Hermes env (reference)

```
NTFY_SERVER_URL=http://<tailscale-ipv4>:2586
NTFY_TOPIC=<random-unlisted-topic>
NTFY_PUBLISH_TOPIC=<same-as-topic>
NTFY_HOME_CHANNEL=<same-as-topic>
```

HTTP on the tailnet is enough. Do not point this at public `ntfy.sh` for
calendar or mail content. Optional `NTFY_TOKEN` only if you later turn on ntfy
auth; the install script does not enable signup or a web UI.

## Alternative: Telegram

Use Telegram if you want to reply from the phone thread. Same Even notification
mirroring applies.

## Skill

`hermes-plugin/skills/g2-notify/SKILL.md` is attached to every job that
delivers to ntfy:

- at most two lines
- lead with the ask
- `[SILENT]` when there is nothing to say
- no markdown

## After fork cutover

```bash
./scripts/bootstrap-jobs.sh eve g2,ntfy
```

That second channel needs this repo listening on `:3141`. Do not pass `g2`
until Oscar says go.
