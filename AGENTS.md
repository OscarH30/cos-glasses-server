# COS Glasses (OscarH30 fork)

**Upstream:** [ukaoma/cos-glasses-server](https://github.com/ukaoma/cos-glasses-server) (MIT).  
**This fork:** [OscarH30/cos-glasses-server](https://github.com/OscarH30/cos-glasses-server).  
**Even Hub developer portal:** Oscar has access. The phone plugin that talks to this server is **not** in this repo — that work is a separate Even Realities / Even Hub app. Do not invent an unpublished plugin here.

## Why this fork exists

Live VPS still runs the **published** `@gotcos/glasses-server@6.44.4` plus a host shim (`/opt/cos-glasses/hermes-ollama-shim.cjs`). Cos’s HUD injects `You are COS…` and Cos’s memory into every Ollama turn. The shim strips that and prepends Eve. That is a workaround.

This fork is the place to make Hermes a first-class backend so Cos’s identity, morning-brief pipeline, and Claude-CLI launcher requirement can go away. **Do not deploy this fork to the VPS until Oscar says go.**

## Target shape (for the chat that tailors this)

1. **Hermes provider.** OpenAI-compatible client to `http://127.0.0.1:8643/v1` with `model: hermes-agent`. Session header `X-Hermes-Session-Id`. Do not go through a fake Ollama. Do not call `claude` / `codex` / Cursor CLIs from the glasses path.
2. **Drop Cos’s mind.** `server/lib/ollama-tools.ts` (`buildOllamaSystemPrompt`) and `server/lib/context-builder.ts` currently force “You are COS”. Replace with Eve / Oscar’s HUD prompt, or better: pass through Hermes’s own system (the agent already has SOUL + vault). HUD overlay should be short: G2 screen, 2–4 lines, no Cos voice.
3. **Launcher.** Cos requires a signed-in Claude CLI before `ask()`. Hermes path should not. The live VPS uses a stub `/home/cos/bin/claude` — delete that requirement here.
4. **Even Hub frontend.** Separate from this Node server. Use the Even Hub developer portal. Goal: a HUD that is ours (Hermes/Eve), not Cos’s default chrome. Do not publish or submit an app without Oscar’s explicit go.
5. **Hard gates.** Nothing sends, publishes, spends, or creates accounts without Oscar. Do not bind `:3141` to the public internet. Pairing stays on Tailscale (`100.87.43.24:3141`).

## Live VPS (do not break until cutover)

- Pairing: `http://100.87.43.24:3141`
- Token: `ssh cg-vps-key 'grep ^COS_API_TOKEN= /home/cos/.cos-glasses/.env'` — do not print it in chat.
- Units: `cos-hermes-shim.service`, `cos-glasses-server.service` (user `cos`).
- Vault notes: `Company/Projects/COS-Glasses-Hermes/` in the Second Brain.

## Remotes

```
origin    git@github.com:OscarH30/cos-glasses-server.git
upstream  git@github.com:ukaoma/cos-glasses-server.git
```

Pull upstream periodically. Do not force-push to `upstream`.
