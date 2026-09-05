# Hermes ops (do not deploy until Oscar says go)

Pinned Hermes surface: the same `gateway.platforms` imports the ntfy adapter
uses (`BasePlatformAdapter`, `MessageEvent`, `MessageType`, `SendResult`,
`PlatformConfig`, `Platform`). Re-check after a Hermes upgrade.

## Units

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

## Plugin install

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
The plugin token never leaves the host.
