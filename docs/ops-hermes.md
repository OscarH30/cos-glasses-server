# Hermes ops (do not deploy the fork until Oscar says go)

Pinned Hermes surface: the same `gateway.platforms` imports the ntfy adapter
uses (`BasePlatformAdapter`, `MessageEvent`, `MessageType`, `SendResult`,
`PlatformConfig`, `Platform`). Re-check after a Hermes upgrade.

## What the upgraded VPS can take now

These do **not** replace `@gotcos/glasses-server@6.44.4` or
`cos-hermes-shim.service`:

| Add | Script | Why |
|---|---|---|
| Self-hosted ntfy on Tailscale IPv4 only | `scripts/install-ntfy-tailscale.sh` | Tier 1 popups without public `ntfy.sh` |
| `g2-notify` skill | `scripts/install-g2-notify-skill.sh eve` | Two-line, `[SILENT]`-aware briefs |
| Morning brief cron (`deliver: ntfy`) | `scripts/bootstrap-jobs.sh eve ntfy` | Replaces Cos morning-brief without this fork |
| Reachability | `scripts/remote-health.sh` | Glasses `/api/health` + ntfy + Hermes; no secrets printed |

See `docs/notifications.md` for the iPhone / Even app steps.

Leave alone until cutover: `:3141` bind, the published glasses-server package,
the Ollama shim, `/home/cos/bin/claude`, and `g2` as a Hermes deliver target.

## Units (after cutover)

```
cos-glasses-server.service
hermes-gateway-eve.service   # After=cos-glasses-server.service
```

The plugin connects *to* this server, so the glasses process must be listening
first.

At cutover, remove:

- `cos-hermes-shim.service`
- `/opt/cos-glasses/hermes-ollama-shim.cjs`
- `/home/cos/bin/claude`

Optional later: `ntfy.service` is already on the box from the script above.

## Plugin install (cutover only)

```bash
./scripts/install-hermes-plugin.sh eve
hermes -p eve plugins enable g2-platform
```

Copy `HERMES_PLUGIN_TOKEN` from `~/.cos-glasses/.env` into
`~/.hermes/profiles/eve/.env` as `G2_PLUGIN_TOKEN`.
`G2_SERVER_URL=http://127.0.0.1:3141`.

```yaml
security:
  approval:
    transport: g2
    transport_fallback: builtin
```

## Network

`:3141` stays on Tailscale/LAN. Hermes API server stays on `127.0.0.1`.
ntfy listens on the Tailscale IPv4 only (`:2586` in the install script).
The plugin token never leaves the host.
