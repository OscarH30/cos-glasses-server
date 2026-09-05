# g2 Hermes platform plugin

Installs Even G2 as a Hermes gateway channel. The adapter speaks the loopback
`/hermes/*` protocol on `cos-glasses-server`.

## Install (per Hermes profile)

```bash
./scripts/install-hermes-plugin.sh eve
hermes -p eve plugins enable g2-platform
```

Then in `~/.hermes/profiles/eve/.env`:

```
G2_SERVER_URL=http://127.0.0.1:3141
G2_PLUGIN_TOKEN=<same value as HERMES_PLUGIN_TOKEN on the glasses server>
G2_HOME_CHANNEL=g2
G2_ALLOWED_USERS=g2
```

And in Hermes `config.yaml`:

```yaml
security:
  approval:
    transport: g2
    transport_fallback: builtin
```

Restart the profile gateway: `hermes -p eve gateway restart`.
