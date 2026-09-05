# Hermes-only redesign plan

Status: proposal, revision 2. Nothing in this document is deployed. The live
VPS stays on `@gotcos/glasses-server@6.44.4` plus the Ollama shim until Oscar
says go (see `AGENTS.md`).

Revision 2 replaces the "this server is an API-server client" design with
"this server is a **Hermes gateway platform**". The G2 becomes a first-class
Hermes channel, like Telegram or ntfy, instead of a frontend that polls an
agent. The reason is in section 2: Even Hub apps cannot receive pushes or run
in the background, so proactive Eve has to arrive through channels the Even
app already mirrors, and interaction has to be modelled as a chat platform
that tolerates the glasses app being absent.

---

## 1. Where we are

Verified against the tree at `7995337` (130k lines incl. tests, no CI).

| Concern | Today | Coupling |
|---|---|---|
| Chat routing | `server/lib/model-router.ts` fans out to `claude-bridge.ts` (spawns `claude -p`), `codex-bridge.ts`, `cursor-bridge.ts`, `ollama-bridge.ts` | Cos |
| Model slots | `shared/model-preference.ts`: `opus/fable/sonnet/haiku/codex-*/cursor-*/ollama` | Cos |
| Identity | `context-builder.ts:184` "You are COS (Chief of Staff)…", `ollama-tools.ts:351` "You are COS…" | Cos |
| Memory / context | `fetchLiveContext()` via Python bridge (`COS_SCRIPTS_DIR`), `memory.ts`, `context-library-search.ts` | Cos |
| Scheduling | `morning-brief-*.ts`, `task-dispatcher.ts` / `task-store.ts` | Cos |
| Launcher gate | `bin/cli.cjs:347` `hasUsableAgent` exits unless Claude/Codex/Cursor is signed in | Cos |
| Sessions | `conversation.ts` replays 20 exchanges as prompt text from `sessions.json` | Cos |
| Desktop agent browsing | `agent-session-*.ts`, `agent-session-bindings.ts`, `thread-*.ts`, `fork-thread.ts` (~12k lines) | Cos |
| Pairing / auth / network | `X-Cos-Token`, `network-policy.ts` (loopback, Tailscale, RFC1918), `:3141` | Generic, keep |
| Display | `display-bus.ts`, `routes/display.ts` SSE with HMAC tickets | Generic, keep |
| Durable jobs | `query-job-*.ts`: fsync-then-202, reattach after phone backgrounds | Generic, keep |
| Speech / media / meetings | `transcribe*`, `whisper-local`, `tts*`, `media-store`, meeting pipeline | Generic, keep |
| OpenAI-compat | `routes/openai-compat.ts` for Even AI "Add Agent" | Generic shape, rewire |

## 2. Runtime constraints that shape everything

From the Even Hub docs (Background & Lifecycle, FAQ, App Submission, updated
Jun–Aug 2026) and the Even support centre:

| Fact | Consequence |
|---|---|
| A Hub app is a WebView inside the Even Realities phone app; the glasses only render containers and emit input events | All logic runs on the phone; this server talks to the phone, never to the glasses |
| iOS: the WebView keeps running with the phone locked and the Even app backgrounded; WebSockets "typically hold". Android: may be suspended under memory pressure | A resident app works with the phone in a pocket on iOS; on Android it works while foregrounded and must cold-start cleanly |
| Plugins are foreground-only on the glasses: no push, no network while suspended, one app in front at a time | Our app cannot be the channel for *unsolicited* delivery. Opening Navigate/Teleprompt/another Hub app exits ours |
| The Even app mirrors phone notifications onto the glasses as popups even while another glasses app runs, and keeps a Notification Center browsable with the ring. Notifications-only, no reply | Anything that reaches the phone as a notification reaches the glasses regardless of which app is in front |
| Even AI "Add Agent" points the built-in voice assistant at a custom OpenAI-compatible endpoint | A pull path from the glasses menu that needs no Hub app |
| SDK 0.0.14: contextual menu with up to 10 action items (`menuObject`), long-press events; root double-tap must call `shutDownPageContainer(1)` | Approve / deny / snooze can be native menu items inside our app |
| Beta/QA installs are tested with the phone locked and the Even app backgrounded | The resident-dashboard posture is what reviewers expect, not a hack |

Hermes side (API Server, Cron, Plugins, ntfy docs, Sep 2026):

| Fact | Consequence |
|---|---|
| Gateway platforms are plugins: `plugins/platforms/<name>/{plugin.yaml,adapter.py}` calling `ctx.register_platform(...)` with `adapter_factory`, `env_enablement_fn`, `standalone_sender_fn`, `cron_deliver_env_var`, `platform_hint`, `max_message_length` | A `g2` platform is ~400 lines of Python (the ntfy adapter is the template) and needs no Hermes core change |
| User platform plugins live in `~/.hermes/plugins/platforms/<name>/` and are opt-in via `plugins.enabled` | Installed per profile, explicitly consented |
| `ctx.register_approval_transport(name, present)` routes Hermes tool-approval prompts to a custom UI; selected via `security.approval.transport`; failures deny by default, `transport_fallback: builtin` shows the prompt on the originating chat instead | "Ask me before sending" becomes a Hermes-owned approval that we merely *present* on the glasses |
| Cron delivers to any platform (`deliver: "g2"`, `"g2,ntfy"`, `"origin"`, `"all"`), honours `[SILENT]`, supports `continuity`, skills, `enabled_toolsets` | Scheduled briefs land on the glasses with no polling |
| Gateway chat commands `/new`, `/sessions`, `/resume`, `/model`, `/cron`, `/bg`, `/status` are plain messages | Session management on the glasses is text through the platform, not a REST proxy |
| ntfy adapter (shipped May 2026) publishes to a topic the ntfy phone app subscribes to; Telegram/Signal/etc. likewise | Zero-code push channel from Hermes to the phone, mirrored to the lens by the Even app |
| API server (`/v1/*`, `/api/sessions`, `/api/jobs`, `/v1/runs`) remains available on the same gateway | Kept as a secondary surface for Even AI passthrough, utility completions and the phone's job editor |
| The ntfy adapter source carries a `PLUGIN-COMPAT` block for a "Sep 2026 decomposition" of `gateway.platforms` imports | Pin the Hermes version we develop against; keep imports to `BasePlatformAdapter`, `MessageEvent`, `SendResult`, `PlatformConfig` |

## 3. Target architecture: three delivery tiers

```
                    ┌──────────────────────────────────────────────┐
                    │ Hermes gateway, profile "eve"  (~/.hermes/…)  │
                    │ SOUL · memory · skills · tools · cron        │
                    │ platforms: g2 (plugin) · ntfy · telegram …    │
                    │ approval transport: g2                        │
                    └───────┬──────────────────┬───────────────────┘
      Tier 1 attention      │                  │ Tier 2 interaction
      deliver: ntfy         │                  │ deliver: g2 / origin
                            ▼                  ▼ loopback SSE in, POST out
                     ntfy / Telegram    cos-glasses-server :3141 (this repo)
                            │           ├─ /hermes/*  plugin-facing (loopback, plugin token)
                            │           ├─ inbox + approvals stores (replay on foreground)
                            │           ├─ display bus · durable jobs · STT/TTS · media
                            │           └─ /v1/chat/completions passthrough (Tier 3)
                            ▼                  │ HTTPS over Tailscale, X-Cos-Token
              phone notification               ▼
                            │           Even Hub "Eve" app (separate repo)
                            ▼           resident dashboard · approvals · voice
              Even app mirrors popup           │ BLE
                            └──────────────────┴────────► Even G2
```

**Tier 1 — attention (Eve tells you something).** Hermes → ntfy (or
Telegram) → phone notification → Even app popup on the lens. Works with the
phone locked and any glasses app in front. Zero code in this repo; it is
Hermes configuration plus a skill that writes notification-shaped output.
This is the layer that makes proactive Eve reach the glasses at all.

**Tier 2 — interaction (you answer, ask, approve).** Hermes treats the G2 as
a chat platform via the `g2` plugin. This server is the platform's transport:
it receives Hermes messages and approval requests, queues them, and fans them
out to the Eve Hub app over the existing display bus; it forwards taps, menu
choices and speech from the app back to Hermes as ordinary gateway messages.
When the app is not in front, messages wait in the inbox and approvals fall
back to the originating chat (Tier 1 channel) after a timeout.

**Tier 3 — pull without the app.** Even AI "Add Agent" → our
`/v1/chat/completions` → Hermes API server. Voice questions from the glasses
menu with nothing installed but the endpoint.

Design rules:

1. Hermes owns persona, memory, sessions, scheduling and approval policy.
   This server never composes a system prompt; display constraints reach the
   model through the plugin's `platform_hint`.
2. This server is a transport and a cache, not an agent client. The only
   agent-facing HTTP it makes is Tier 3 passthrough and utility completions.
3. The Hub app is a resident dashboard: launch it and leave it; it
   reconnects and replays on `FOREGROUND_ENTER_EVENT`.
4. Hard gates unchanged: `:3141` stays on Tailscale/LAN, the plugin token and
   the Hermes API key never leave the host, nothing is published or deployed
   without Oscar.

## 4. The `g2` Hermes platform plugin

Lives in this repo under `hermes-plugin/g2/` and is installed into
`~/.hermes/profiles/<profile>/plugins/platforms/g2/` by
`scripts/install-hermes-plugin.sh` (copy or symlink; enable with
`hermes -p <profile> plugins enable g2-platform`). The Python code depends only
on `httpx` (already a Hermes dependency) and the same four imports the ntfy
adapter uses.

### 4.1 Files

```
hermes-plugin/g2/
├── plugin.yaml      kind: platform; requires_env G2_SERVER_URL, G2_PLUGIN_TOKEN
├── adapter.py       G2Adapter(BasePlatformAdapter) + register(ctx)
├── approval.py      approval transport: present(request) → server → decision
└── README.md        install, config keys, wire protocol
```

### 4.2 Registration

```python
def register(ctx):
    ctx.register_platform(
        name="g2", label="Even G2",
        adapter_factory=lambda cfg: G2Adapter(cfg),
        check_fn=check_requirements, validate_config=validate_config,
        is_connected=is_connected,
        required_env=["G2_SERVER_URL", "G2_PLUGIN_TOKEN"],
        env_enablement_fn=_env_enablement,          # shows in `gateway status`
        cron_deliver_env_var="G2_HOME_CHANNEL",      # deliver: g2
        standalone_sender_fn=_standalone_send,       # out-of-process cron
        allowed_users_env="G2_ALLOWED_USERS", allow_all_env="G2_ALLOW_ALL_USERS",
        max_message_length=600,                      # ~10 HUD lines
        emoji="👓", pii_safe=True, allow_update_command=False,
        platform_hint=(
            "You are speaking on Even G2 smart glasses: a 576x288 monochrome "
            "display showing about four short lines at a time, read while "
            "walking. Lead with the answer or the question in one or two "
            "lines. Plain text only: no markdown, tables, code fences or "
            "emoji. Expand only when asked. If a decision is needed, state it "
            "as a yes/no question."
        ),
    )
    ctx.register_approval_transport("g2", present_approval)
```

Env (per profile `.env`): `G2_SERVER_URL` (default `http://127.0.0.1:3141`),
`G2_PLUGIN_TOKEN` (shared secret minted by this server on first boot, stored
in `~/.cos-glasses/.env` as `HERMES_PLUGIN_TOKEN`), `G2_HOME_CHANNEL`
(default `g2`), `G2_ALLOWED_USERS` (default `g2`). Identity follows the ntfy
model: one trusted channel, `user_id == chat_id == "g2"`, `chat_type="dm"`;
authorization comes from the token, never from message fields.

### 4.3 Wire protocol (plugin ↔ this server, loopback only)

Mirrors the ntfy adapter: stream in, POST out. The plugin is the client; this
server is the listener. All routes are under `/hermes/`, require
`Authorization: Bearer <HERMES_PLUGIN_TOKEN>`, and are refused from non-loopback
addresses regardless of token.

| Direction | Route | Body | Notes |
|---|---|---|---|
| plugin ← server | `GET /hermes/stream` (SSE) | `event: message` `{ id, text, attachments?[], reply_to?, correlation_id }`; `event: approval_decision` `{ request_id, choice }`; `event: keepalive` | One connection per adapter; `Last-Event-ID` replay from the inbound ledger; reconnect with the ntfy backoff table |
| plugin → server | `POST /hermes/deliver` | `{ chat_id, text, reply_to?, correlation_id?, kind: "reply"\|"cron"\|"notice"\|"progress", media?[] }` | Returns `{ message_id }`; `progress` maps to display `tool_status`; `reply` with a `correlation_id` completes the matching durable job |
| plugin → server | `POST /hermes/approval` | `{ request_id, digest, command, description, choices[], timeout_s, origin }` | Server stores it, emits `approval_required` on the display bus, returns immediately |
| plugin → server | `GET /hermes/approval/{request_id}` (long-poll ≤ timeout) | — | `{ choice }` or `408`; `present_approval` awaits this and returns `request.respond(choice)` |
| plugin → server | `POST /hermes/typing` | `{ chat_id, on }` | Optional; drives the lens "Eve is working…" line |
| plugin → server | `GET /hermes/health` | — | Adapter `connect()` probe |

`_standalone_send` posts to `/hermes/deliver` with `kind: "cron"` so
`deliver: g2` works even when cron runs out of process.

### 4.4 Message lifecycle

- **Glasses → Hermes.** Phone `POST /api/query-jobs` (unchanged contract) →
  server persists the job, emits `message` on `/hermes/stream` with the job
  id as `correlation_id` → adapter `handle_message(MessageEvent)` → Hermes
  runs the turn in the `g2` chat session → `adapter.send()` →
  `POST /hermes/deliver { correlation_id }` → server completes the job, writes
  the answer to the display bus and to the inbox.
- **Hermes → glasses (unsolicited).** Cron or a `send_message` tool call →
  `deliver` with no `correlation_id` → inbox entry + display card. If no phone
  is attached to the display bus, the entry waits; the app fetches
  `GET /api/inbox?since=<cursor>` on foreground.
- **Approval.** Hermes gates a tool → transport `present()` →
  `POST /hermes/approval` → display `approval_required` → app renders
  Approve / Deny / Always via list or contextual menu → `POST
  /api/approvals/{id} { choice }` → long-poll returns → Hermes proceeds.
  Timeout (Hermes `approvals.timeout`) → deny, and with
  `security.approval.transport_fallback: builtin` the prompt re-appears on
  the originating chat (e.g. Telegram), which is the "phone in pocket" path.
- **Streaming.** Gateway adapters receive the final message plus progress
  hooks, not token deltas. The lens shows `tool_status` lines during the turn
  and the answer at once, which suits a four-line display. If token streaming
  turns out to matter, the Tier 3 API-server path has it.
- **Chat commands.** `/new`, `/sessions`, `/resume <name>`, `/model`, `/cron
  list`, `/status` are sent as plain text from the app's menu and answered by
  the gateway like any other platform.

### 4.5 Profiles

Each Hermes profile runs its own gateway and its own `g2` adapter instance,
each connecting to `/hermes/stream?profile=<name>`. The server keeps one
inbound ledger per profile and exposes `GET /api/agent/profiles` →
`[{ name, label, connected, lastSeen }]` for the phone picker. A session on
the phone is bound to one profile; switching profiles is a new conversation.
The "model picker" of the Cos era becomes this profile picker; per-turn
effort (`high|xhigh|max`) is sent as a `/model --once` prefix only when the
user asks for it.

## 5. What this server becomes

Kept as-is: `index.ts` listen/bind, `api-auth.ts`, `network-policy.ts`,
`display-bus.ts`, `routes/display.ts`, `query-job-*.ts`, all speech, media
and meeting modules, `maintenance-lifecycle.ts`, `message-era.ts`.

New:

| Module | Role |
|---|---|
| `server/routes/hermes-platform.ts` | The `/hermes/*` routes from 4.3; loopback + plugin-token guard |
| `server/lib/hermes/inbound-ledger.ts` | Append-only outbound-to-Hermes log per profile with `Last-Event-ID` replay |
| `server/lib/hermes/inbox.ts` | Delivered messages with cursor, read state, TTL; feeds `GET /api/inbox` and the display bus |
| `server/lib/hermes/approvals.ts` | Pending approval store with expiry, long-poll waiters, `POST /api/approvals/:id` |
| `server/lib/hermes/profiles.ts` | Connected-adapter registry, health, `GET /api/agent/profiles` |
| `server/lib/hermes/turn-runner.ts` | The durable-job runner for the platform path: emit inbound, await matching `deliver`, map progress to `tool_status`, timeout → job failure with a lens-safe message |
| `server/lib/hermes/api-client.ts` | Thin API-server client (bearer `HERMES_API_KEY`) used only by Tier 3 passthrough, `completeOnce()` utility completions and the optional jobs editor |

Changed:

- `routes/query-jobs.ts` / `query-job-runtime.ts`: the runner calls
  `turn-runner.ts` instead of `callModelStreaming`. Job identity, fsync,
  reattach and cancel semantics are untouched; cancel emits a `/stop`-style
  text to the gateway (Hermes' busy-input "interrupt" behaviour).
- `routes/query.ts` (legacy SSE): thin wrapper over the same runner.
- `routes/openai-compat.ts`: becomes a passthrough to the profile's API
  server with `X-Hermes-Session-Id` per calendar day and
  `X-Hermes-Session-Key: agent:main:g2:<owner>`; `/v1/models` advertises
  connected profiles.
- `conversation.ts`: shrinks to a phone-facing projection (glasses session id
  ↔ profile ↔ last N delivered cards) for the display bus and message
  numbering; it no longer feeds any prompt.
- `dictation-clean.ts`, `prompt-edit.ts`, `archive.ts`, `meeting-summary.ts`:
  swap `spawn('claude', …)` for `completeOnce()` with a throwaway
  `X-Hermes-Session-Id`, same budgets as today.

## 6. Sequencing

| Phase | Deliverable | Where the work is |
|---|---|---|
| 0 | Tier 1 live: ntfy (or Telegram) channel, G2-notification skill, Even app notification permissions | Hermes config + `docs/notifications.md`; no server code |
| 1 | `g2` plugin + `/hermes/*` routes + inbox/approvals/profiles stores; `deliver: g2` and an approval round-trip work against a dev gateway | `hermes-plugin/g2/`, new `server/lib/hermes/*`, `routes/hermes-platform.ts` |
| 2 | Glasses chat through the platform: durable jobs → gateway turns; `/new`/`/sessions` from the app; profile picker; Tier 3 passthrough rewired | `turn-runner.ts`, `query-job-runtime.ts`, `openai-compat.ts`, `conversation.ts`, `shared/agent-preference.ts` |
| 3 | Scheduling on Hermes cron: morning brief and tasks recreated as jobs with `deliver: "g2,ntfy"`; optional phone jobs editor via API-server `/api/jobs` proxy | `morning-brief-*`, `task-*` retired; `routes/jobs.ts` (optional) |
| 4 | Launcher, health, config, ops | `bin/cli.cjs`, `routes/health.ts`, `.env.example`, `docs/ops-hermes.md` |
| 5 | Delete Cos | Bridges, catalogs, ledgers, agent-session browsing, Python bridge, identity strings |
| 6 | Hub app contract + docs | `docs/hud-api.md`, README, CHANGELOG 7.0.0 |

Each phase ends with `npm test` and `npm run typecheck` green and a tagged
commit. Phases 1–3 are additive; the Cos paths keep working until Phase 5.

### 6.1 Phase 0 — attention channel (Hermes side only)

- `hermes -p eve gateway setup` → ntfy: `NTFY_TOPIC=<random>`,
  `NTFY_PUBLISH_TOPIC` same, no `NTFY_ALLOWED_USERS` (outbound-only),
  `NTFY_SERVER_URL` pointing at a self-hosted ntfy on the VPS behind
  Tailscale (the public `ntfy.sh` is fine for a trial, not for calendar or
  mail content). Telegram is the alternative if Oscar prefers a channel he can
  reply in.
- Phone: ntfy app subscribed to the topic; Even app → Settings →
  Notification → enable for ntfy; popup mode ON.
- Skill `g2-notify` in the profile: output ≤ 2 lines, lead with the ask,
  `[SILENT]` when nothing to say, no markdown. Attached to every job that
  delivers to ntfy.
- Recreate the morning brief as a first job here so Tier 1 is validated end
  to end before any server code changes:
  `hermes -p eve cron create "daily at 06:30" "<brief prompt>" --skill
  g2-notify --deliver ntfy --continuity`.

### 6.2 Phase 1 — plugin and transport

- Write `hermes-plugin/g2/` per section 4. Unit tests in Python with a fake
  server (httpx `MockTransport`), covering reconnect backoff, dedup,
  `standalone_send`, approval timeout → deny.
- Server: `routes/hermes-platform.ts` and the three stores. Plugin token
  minted at boot if `HERMES_PLUGIN_TOKEN` is unset, written to
  `~/.cos-glasses/.env`, printed once (same pattern as `COS_API_TOKEN`).
- Display bus: new event types `hermes_message`, `approval_required`,
  `approval_resolved`, `agent_status`. Ticketless subscribers still get
  lifecycle-only projections (existing 6.42 rule).
- `GET /api/inbox?since=`, `POST /api/inbox/:id/read`,
  `POST /api/approvals/:id`, `GET /api/agent/profiles`.
- Exit: on a dev box, `hermes -p eve cron create "in 1m" "say hello"
  --deliver g2` shows on the display stream; a gated `terminal` call presents
  an approval that a curl to `/api/approvals/:id` resolves.

### 6.3 Phase 2 — chat through the platform

- `turn-runner.ts` implements the runner interface `query-job-coordinator.ts`
  already expects. Correlation by job id; progress → `tool_status`; a turn
  with no `deliver` inside Hermes' per-turn timeout fails the job with
  "Eve did not answer; check the gateway."
- Attachments: images are passed in the inbound event as
  `{ url: "http://127.0.0.1:3141/api/media/file/<id>?plugin=1" }`, fetched by
  the adapter with the plugin token and attached to `MessageEvent` as the
  gateway expects for image input. Non-image attachments are rejected before
  the job is admitted.
- `shared/model-preference.ts` → `shared/agent-preference.ts`:
  `{ profile: string; effort?: 'high'|'xhigh'|'max' }`; legacy model strings
  normalise to the default profile for one release.
- `openai-compat.ts` rewired to the API client; Even AI passthrough tested
  from the glasses menu.
- Exit: full round trip from the Hub app (or curl) through the gateway and
  back, with `/new` starting a fresh Hermes session.

### 6.4 Phase 3 — scheduling

- Morning brief and task dispatch recreated as Hermes jobs
  (`deliver: "g2,ntfy"`, `continuity: true`, skills as needed). Jobs are
  created once by `scripts/bootstrap-jobs.sh` from the existing
  `morning-brief-config` values, then owned by Hermes.
- `morning-brief-scheduler.ts`, `morning-brief-runtime.ts`,
  `task-dispatcher.ts`, `task-store.ts` removed; `routes/morning-brief.ts`
  and `routes/tasks.ts` return `410 Gone` with a pointer for one release.
- Optional: `routes/jobs.ts` proxying an allowlisted subset of the API
  server's `/api/jobs` (list, pause, resume, run, edit prompt/schedule) for a
  phone-side editor. The chat-command path (`/cron list`, `/cron pause <id>`)
  already covers the glasses; the proxy exists only if Oscar wants a
  touch UI on the phone.

### 6.5 Phase 4 — launcher, health, config, ops

- `bin/cli.cjs`: delete Claude/Codex/Cursor probes and the `hasUsableAgent`
  exit. Replace with: print plugin token status, list connected profiles,
  probe the API server if `HERMES_API_KEY` is set. Warn, never exit: display,
  speech and meetings work without Hermes.
- `routes/health.ts`: `hermes: { profiles: [...], apiServer: ok|down,
  inbox: n, pendingApprovals: n }`; drop `health-static-probes.ts` and
  `provider-proof.ts`.
- `.env.example`: `HERMES_PLUGIN_TOKEN`, `HERMES_API_URL`, `HERMES_API_KEY`,
  `HERMES_DEFAULT_PROFILE`; delete every `COS_CLAUDE_*`, `COS_CODEX_*`,
  `COS_CURSOR_*`, `COS_OLLAMA_*`, `COS_SCRIPTS_DIR`, `COS_OPERATIONS_DIR`.
- `docs/ops-hermes.md`: unit ordering (`cos-glasses-server.service` before
  `hermes-gateway-eve.service`, since the plugin connects to us), plugin
  install per profile, removal of `cos-hermes-shim.service`,
  `/opt/cos-glasses/hermes-ollama-shim.cjs` and `/home/cos/bin/claude` at
  cutover.

### 6.6 Phase 5 — delete Cos

Delete with tests:

| Group | Files |
|---|---|
| Provider bridges | `claude-bridge.ts`, `codex-bridge.ts`, `cursor-bridge.ts`, `ollama-bridge.ts`, `model-router.ts` |
| Catalogs / sessions / ledgers | `codex-*.ts` (4), `cursor-*.ts` (4), `claude-run-ledger.ts`, `claude-circuit.ts`, `claude-permissions.ts`, `claude-session-registry.ts`, `claude-tool-access.ts`, `banned-permission-args.ts`, `ollama-catalog.ts`, `ollama-run-ledger.ts`, `ollama-tools.ts`, `provider-binary.ts`, `provider-proof.ts`, `provider-terminal-error.ts`, `provider-process-lifecycle.ts`, `health-static-probes.ts` |
| Cos mind | `context-builder.ts`, `context-files.ts`, `context-library-search.ts`, `cos-context-browser.ts`, `python-bridge.ts`, `profile.ts` owner-name reads, `routes/welcome-context.ts`, `routes/memory.ts`; `response-cache.ts` trimmed to time/date |
| Scheduling | `morning-brief-*.ts` (6), `task-dispatcher.ts`, `task-store.ts`, `routes/tasks.ts`, `routes/morning-brief.ts` |
| Desktop agent browsing | `agent-session-*.ts` (5), `attached-provider-adapter.ts`, `attached-workspace.ts`, `fork-thread.ts`, `thread-*.ts` (6), `occupancy-probes.ts`, `occupied-threads.ts`, `fence-liveness.ts`, `native-head.ts`, `native-thread-id.ts`, `stranded-session*.ts`, `session-stream-*.ts`, `session-transcript-watcher.ts`, `routes/agent-sessions.ts`, `routes/agent-session-bindings.ts`, `routes/agent-session-stream.ts`, `routes/claude-sessions.ts`, `routes/thread-turn-queue.ts`, `routes/threads.ts` |
| Cos Operations | `cos-operations-meetings.ts`, `g2-ops-handoff.ts`, `live-cues-*.ts` (5), `routes/live-cues.ts`, `telegram-notify.ts` |

`handoff-store.ts` keeps the G2 ↔ desktop handoff shape with `target:
'hermes-session'` implemented as a `/title`-named session the desktop can
`/resume`.

Identity strings: `rg -n "COS|Chief of Staff|gotcos" server shared bin` must
return only the package name, `X-Cos-Token`, and the `COS_API_TOKEN` /
`COS_DATA_DIR` env names (kept for phone compatibility). Package becomes
`@oscarh30/glasses-server`, unpublished.

Expected size after Phase 5: 50–55k lines including tests, from 130k, plus
~1k lines of Python.

### 6.7 Phase 6 — Hub app contract

`docs/hud-api.md` documents the server surface the Eve Hub app (separate
repo) builds against:

- Unchanged: `GET /api/health`, `GET /api/display-stream` (+ tickets),
  `POST /api/query-jobs` (202 + reattach), transcribe / TTS / media routes,
  `X-Cos-Token`.
- New: `GET /api/agent/profiles`, `GET /api/inbox?since=`,
  `POST /api/inbox/:id/read`, `POST /api/approvals/:id { choice }`, display
  events `hermes_message`, `approval_required`, `approval_resolved`,
  `agent_status`.
- Resident-dashboard contract: on `FOREGROUND_ENTER_EVENT` reconnect the
  display stream, `GET /api/inbox?since=<localStorage cursor>`, render the
  newest card; persist cursor and profile in `localStorage`; on
  `FOREGROUND_EXIT_EVENT` do nothing (iOS keeps running). Approvals render as
  a list with Approve / Deny / Always plus a contextual-menu mirror; root
  double-tap calls `shutDownPageContainer(1)`.
- Voice: glasses mic → `/api/transcribe-stream` → text → `/api/query-jobs`,
  unchanged.

README and CHANGELOG get a `7.0.0` entry: Hermes platform, Cos removed,
`HERMES_PLUGIN_TOKEN` required for Tier 2, `HERMES_API_KEY` for Tier 3.

## 7. Testing

- Python: plugin unit tests with `httpx.MockTransport`; a contract test that
  imports only the four `gateway.*` symbols the ntfy adapter uses.
- Node: `fake-hermes-plugin` fixture that speaks the 4.3 protocol, driving
  inbox replay (`Last-Event-ID`), approval long-poll timeout, correlation of
  `deliver` to jobs, multi-profile streams, loopback + token rejection.
- Integration (dev box, not the VPS): `hermes profile create eve-dev`, install
  the plugin, run this server, exercise: `cron create "in 1m" … --deliver
  g2`; a gated tool → approval on `/api/approvals`; a query job round trip;
  `/new`; kill the gateway mid-turn → job fails with the lens-safe message and
  the adapter reconnects.
- Tier 1 check is manual: a `deliver: ntfy` job pops on the lens while
  Navigate is the foreground glasses app.
- `vitest.config.ts` isolation (`COS_DATA_DIR`) kept; add
  `HERMES_API_URL=http://127.0.0.1:0` and `HERMES_PLUGIN_TOKEN=test` so no
  test reaches a real gateway.

## 8. Risks and open decisions

| # | Item | Proposed default | Needs Oscar |
|---|---|---|---|
| 1 | Android WebView suspension makes the resident dashboard "works when open" | Design for iOS; document Android as degraded | Confirm phone platform |
| 2 | Hermes platform-plugin imports are being decomposed (Sep 2026 `PLUGIN-COMPAT`) | Pin the Hermes version in `docs/ops-hermes.md`; import only `BasePlatformAdapter`, `MessageEvent`, `MessageType`, `SendResult`, `PlatformConfig`, `Platform` | No |
| 3 | Approval transport denies on any failure by default | Set `transport_fallback: builtin` so an unanswered glasses prompt re-appears on the originating chat | Yes: accept that fallback |
| 4 | Public `ntfy.sh` sees notification text | Self-hosted ntfy on the VPS behind Tailscale, or Telegram | Yes: channel choice |
| 5 | Gateway path delivers whole answers, not token streams | Accept for the HUD; Tier 3 keeps streaming | No |
| 6 | Plugin runs in-process in Hermes with full trust; server `/hermes/*` is loopback-only | Token + loopback guard; never proxy arbitrary Hermes endpoints to the phone | No |
| 7 | Existing `sessions.json` history is not importable into Hermes | Keep read-only under `legacy/`; start fresh | Yes |
| 8 | `routes/memory.ts` has no Hermes REST equivalent | Drop; ask Eve in chat | Yes |
| 9 | Live cues used Cursor Composer | Delete | Yes |
| 10 | Package identity / upstream sync | Rename, stop tracking upstream after 7.0.0 | Yes |
| 11 | Phone-side job editor | Chat commands only unless asked | Yes |

## 9. Out of scope

- The Even Hub app itself (separate repo; contract in `docs/hud-api.md`).
- Publishing the plugin to the Hermes community index.
- Deploying any of this to `100.87.43.24`.
