# Hermes-only redesign plan

Status: proposal. Nothing in this document is deployed. The live VPS stays on
`@gotcos/glasses-server@6.44.4` plus the Ollama shim until Oscar says go
(see `AGENTS.md`).

This plan turns `cos-glasses-server` from a multi-provider Cos assistant into a
thin **G2 edge for a Hermes Agent gateway**. Hermes owns identity (SOUL),
memory, tools, skills, sessions and scheduling. This server owns only what the
glasses physically need: pairing, the display bus, speech in/out, media, and a
faithful transport to the Hermes API server.

---

## 1. Where we are

Verified against the tree at `7995337` (130k lines incl. tests, no CI).

| Concern | Today | Coupling |
|---|---|---|
| Chat routing | `server/lib/model-router.ts` fans out to `claude-bridge.ts` (spawns `claude -p`), `codex-bridge.ts` (`codex exec`), `cursor-bridge.ts` (`agent`), `ollama-bridge.ts` (HTTP) | Cos |
| Model slots | `shared/model-preference.ts`: `opus/fable/sonnet/haiku/codex-*/cursor-*/ollama` | Cos |
| Identity | `context-builder.ts:184` "You are COS (Chief of Staff)…", `ollama-tools.ts:351` "You are COS…"; owner name from `~/.cos-glasses/.cos-profile.json` | Cos |
| Memory / context | `fetchLiveContext()` via Python bridge (`COS_SCRIPTS_DIR`), `memory.ts`, `context-library-search.ts`, `cos-context-browser.ts` | Cos |
| Scheduling | `morning-brief-*.ts` (30 s tick → durable job), `task-dispatcher.ts` / `task-store.ts` | Cos |
| Launcher gate | `bin/cli.cjs:347` `hasUsableAgent` exits unless Claude/Codex/Cursor is signed in | Cos |
| Sessions | `conversation.ts` keeps history in `~/.cos-glasses/data/sessions.json` and re-sends the last 20 exchanges as prompt text; plus per-provider CLI session maps | Cos |
| Desktop agent browsing | `agent-session-*.ts`, `agent-session-bindings.ts`, `thread-turn-queue*.ts`, `fork-thread.ts`, `claude-sessions.ts` (~12k lines with tests) | Cos |
| Side utilities that spawn `claude` | `dictation-clean.ts`, `prompt-edit.ts`, `archive.ts`, `meeting-summary.ts`, `live-cues-*` | Cos |
| Pairing / auth / network | `X-Cos-Token`, `network-policy.ts` (loopback, Tailscale CGNAT, RFC1918 only), `:3141` | Generic, keep |
| Display | `display-bus.ts`, `routes/display.ts` SSE with HMAC tickets, `display-format.ts` | Generic, keep |
| Durable jobs | `query-job-*.ts`: fsync-then-202, reattach after phone backgrounds | Generic, keep |
| Speech | `transcribe*.ts`, `whisper-local.ts`, `vad-silero.ts`, `tts*.ts` (Kokoro + OpenAI), voice enrolment, meetings | Generic, keep |
| Media | `media-store.ts`, chunked/video upload, `docs/media-upload-contract.md` | Generic, keep |
| OpenAI-compat | `routes/openai-compat.ts` (`/v1/chat/completions`, `/v1/models`) for Even "Add Agent" | Generic shape, rewire |

There is no Hermes code in the tree. The only Hermes reference is `AGENTS.md`.

## 2. Hermes surface we will build on

From the Hermes Agent docs (API Server, Cron, Profiles, Messaging), current as
of Sep 2026. Every item below is feature-detected at boot via
`GET /v1/capabilities`; nothing is assumed.

| Hermes feature | Endpoint / mechanism | What it replaces here |
|---|---|---|
| Gateway | `hermes gateway` daemon: API server, cron ticker (60 s), sessions, delivery ledger | Our process supervision for Cos "mind" |
| API server | `API_SERVER_ENABLED=true`, `API_SERVER_PORT`, `API_SERVER_KEY`, loopback bind by default | `claude`/`codex`/`agent` subprocesses |
| Chat (stateless) | `POST /v1/chat/completions` (SSE, `hermes.tool.progress`, inline `image_url`) | Bridges' streaming loop |
| Runs | `POST /v1/runs` → `run_id`; `GET /v1/runs/{id}`; `GET /v1/runs/{id}/events` SSE; `POST …/stop`; `POST …/approval` | Durable query jobs' provider leg |
| Sessions | `/api/sessions` CRUD, `/{id}/messages`, `/{id}/fork`, `/{id}/chat`, `/{id}/chat/stream` | `conversation.ts` history + CLI session maps |
| Session headers | `X-Hermes-Session-Id` (transcript, rotates on new chat), `X-Hermes-Session-Key` (stable long-term-memory scope) | Our 20-exchange prompt replay |
| System prompt layering | `system` / `instructions` is layered **on top of** Hermes' own SOUL + tools | `buildSystemPrompt` "You are COS" |
| Model selection | per-request `model`, `provider`, `model_options.reasoning_effort`; `model_routes` aliases; `direct_model_requests` | `EffortPreference` → CLI flags |
| Cron / Jobs | `/api/jobs` CRUD, `pause`, `resume`, `run`; skills attach, `enabled_toolsets`, `continuity`, `context_from`, `no_agent` scripts, `[SILENT]`, `wakeAgent` gate | Morning brief pipeline, task dispatcher |
| Profiles | `hermes profile create <name>`; own `HERMES_HOME`, SOUL, memory, sessions, cron, API port/key; model id = profile name; `/p/<profile>/` multiplex routing | Model picker (Opus/GPT/Grok/…) |
| Discovery | `/v1/capabilities`, `/v1/models`, `/v1/skills`, `/v1/toolsets`, `/api/model/options`, `/health`, `/health/detailed` | Provider probes and catalogs |
| Limits | `max_concurrent_runs` → HTTP 429; `Idempotency-Key` header (5 min cache); no file upload, images only | — |

Two facts that shape the design:

- Port `8643` in `AGENTS.md` is a **named-profile** port (default profile is
  `8642`). A named profile advertises its **profile name** as the model id
  unless `API_SERVER_MODEL_NAME=hermes-agent` is set in that profile's `.env`,
  and it needs its own `API_SERVER_KEY`. The client must read `/v1/models`
  rather than hardcode `hermes-agent`.
- Hermes has no "G2" delivery platform. Cron output can go to `local`
  (`~/.hermes/cron/output/{job_id}/`), a messaging channel, or `bot-chat`.
  Getting a scheduled brief onto the glasses needs a bridge (section 5.4).

## 3. Target architecture

```
Even G2 ──BLE──► phone (Even Hub app, separate repo)
                    │  HTTPS over Tailscale, X-Cos-Token
                    ▼
        cos-glasses-server :3141  (this repo, Node)
        ├─ pairing / token / network policy          (unchanged)
        ├─ display bus + SSE tickets                  (unchanged)
        ├─ STT / TTS / meetings / media               (unchanged)
        ├─ durable query jobs                         (kept, provider leg swapped)
        ├─ hermes/                                    (new)
        │   ├─ client.ts       auth, capabilities, retries, 429/401 mapping
        │   ├─ bridge.ts       StreamCallbacks adapter over Runs / chat SSE
        │   ├─ sessions.ts     glasses session ↔ Hermes session index
        │   ├─ jobs.ts         Jobs API proxy + inbox bridge
        │   ├─ profiles.ts     profile registry → picker
        │   └─ hud-prompt.ts   2–4 line display overlay, no persona
        └─ /v1/chat/completions passthrough (Even "Add Agent")
                    │  loopback only, Bearer API_SERVER_KEY
                    ▼
        Hermes gateway (profile "eve" or similar) 127.0.0.1:8643
        SOUL.md · memory · skills · tools · sessions · cron
```

Design rules:

1. One provider. `model-router.ts` collapses to "call Hermes". No Claude,
   Codex, Cursor or Ollama code paths remain, and no fake-Ollama shim.
2. Hermes owns the conversation. This server stops replaying history as prompt
   text; it sends one user turn per request against a Hermes session.
3. Hermes owns the persona. The only instructions we send describe the
   display surface (section 5.2). No owner name, no calendar cache, no "COS".
4. Profiles are the picker. What used to be a model dropdown becomes a
   Hermes-profile dropdown (Eve / work / research …). Effort maps to
   `model_options.reasoning_effort` inside the chosen profile.
5. Scheduling lives in Hermes cron. This server only proxies job CRUD for the
   phone UI and bridges delivered output onto the HUD.
6. Hard gates unchanged: `:3141` stays on Tailscale/LAN, the Hermes API key
   never leaves this host, nothing is published or deployed without Oscar.

## 4. Sequencing

Six phases. Each ends in a passing `npm test` / `npm run typecheck` and a
tagged commit on this fork. Phases 1–2 are additive (Cos paths still work),
so the branch stays runnable for A/B on a dev box; Phase 5 is the deletion.

| Phase | Deliverable | Invasiveness |
|---|---|---|
| 1 | Hermes client + bridge behind a new `hermes` model slot | Additive: new `server/lib/hermes/`, 1 branch in `model-router.ts`, 1 slot in `shared/model-preference.ts` |
| 2 | Sessions handed to Hermes; HUD prompt; profiles picker | Rewrites `conversation.ts` role, `openai-compat.ts`, `routes/sessions.ts`; new `/api/agent/*` routes |
| 3 | Cron replaces morning brief + tasks | New `hermes/jobs.ts`, `routes/jobs.ts`; `morning-brief-*`, `task-*` become thin shims then go |
| 4 | Launcher, health, config, ops | `bin/cli.cjs`, `routes/health.ts`, `.env.example`, systemd notes |
| 5 | Delete Cos | Remove bridges, catalogs, ledgers, agent-session browsing, Python bridge, identity strings |
| 6 | Even Hub contract + docs | `docs/hud-api.md`, README rewrite, CHANGELOG 7.0.0 |

## 5. Phase detail

### 5.1 Phase 1 — Hermes client and bridge

New directory `server/lib/hermes/`.

**`client.ts`**

- Config (all read in `server/env.ts` order: `~/.cos-glasses/.env` → repo
  `.env` → process env):
  - `HERMES_API_URL` default `http://127.0.0.1:8643` (no `/v1`; the client
    appends paths). Refuse non-loopback and non-Tailscale hosts unless
    `HERMES_ALLOW_REMOTE=1`.
  - `HERMES_API_KEY` required. Startup fails closed with a clear message if
    absent; this is the only credential the glasses path needs.
  - `HERMES_MODEL` optional override; otherwise the first id from
    `/v1/models`.
  - `HERMES_SESSION_KEY_PREFIX` default `agent:main:g2`.
- Boot probe: `GET /health`, then `GET /v1/capabilities` with the key. Cache
  the capabilities object; expose it via `/api/health` as `hermes: { ok,
  model, profile, runs, sessions, jobs, session_key_header }`.
- Transport helpers: `fetchJson`, `openSse` (line parser for `event:`/`data:`
  frames, honours `AbortSignal`), `Idempotency-Key` on every run-starting
  POST so a phone retry after a lost 202 does not start a second turn.
- Error mapping to user strings shown on the lens:
  - connection refused → "Hermes gateway is not running."
  - 401 → "Hermes API key rejected." (never echo the key)
  - 429 → "Hermes is busy (N runs). Try again shortly." with `Retry-After`
  - 400 `unsupported_content_type` → "Only photos can be attached."

**`bridge.ts`** — `callHermesStreaming(query, sessionId, callbacks, options)`
implementing the existing `StreamCallbacks` / `CallOptions` contract
(`server/lib/claude-bridge.ts:330-394`) so `routes/query.ts`,
`query-job-runtime.ts` and `openai-compat.ts` keep working unchanged.

Transport selection, in order of preference by capability flag:

1. `run_submission && run_events_sse`: `POST /v1/runs` with `{ input,
   session_id, instructions, model_options }`, then `GET
   /v1/runs/{id}/events`. Token deltas → `onChunk`; `tool.*` /
   `hermes.tool.progress` → `onToolStatus`; `subagent.*` → `onToolStatus`
   ("Delegating…"); terminal → `onDone`/`onError`. Return `run_id` in
   `ModelRunMetadata` so the durable job store can poll `GET /v1/runs/{id}`
   after a reconnect and call `POST …/stop` on cancel. This is the only
   transport that gives the phone a reattach-after-background story equal to
   today's Claude one.
2. Else `session_chat_stream`: `POST /api/sessions/{id}/chat/stream`.
3. Else `/v1/chat/completions` with `stream: true`, `X-Hermes-Session-Id`,
   sending only the single user message (Hermes has the transcript).

Common behaviour:

- Headers: `Authorization: Bearer`, `X-Hermes-Session-Id: <hermes session>`,
  `X-Hermes-Session-Key: ${prefix}:${ownerId}` (stable per paired phone so
  Honcho-style long-term memory does not fragment when the transcript rotates).
- Images: `ModelImageInput` → `data:image/...;base64` `image_url` parts.
  Non-image attachments are rejected before the call with the 400 string above.
- Effort: `EffortPreference` `high|xhigh|max|ultracode` →
  `model_options.reasoning_effort` `high|xhigh|max|ultra`. No `model` or
  `provider` is sent from the glasses path (profile decides), so the
  `direct_model_requests` flag is irrelevant.
- Timeouts: reuse the inactivity + wall + hard-max pattern from
  `ollama-bridge.ts:41-50`, but with the wall at 10 min because Hermes turns
  are agentic. SSE comments (`: keepalive`) are already emitted upstream by
  `openai-compat.ts`; `routes/query.ts` gets the same.
- Ledger: `hermes-run-ledger.ts` mirroring `ollama-run-ledger.ts` (run id,
  session, status, error class) so `/api/cli-debug` and health keep working.

**Wiring**

- `shared/model-preference.ts`: add `'hermes'` slot; `isHermesModel`;
  labels `Hermes` / `HRM` / tag `E`. Keep other slots for now.
- `model-router.ts`: `if (isHermesModel(resolved)) return callHermesStreaming(...)`.
- `COS_G2_DEFAULT_MODEL=hermes` becomes the documented default in
  `.env.example`.
- Tests: `server/lib/hermes/__fixtures__/fake-hermes.ts` — an in-process
  Express fake implementing `/health`, `/v1/capabilities`, `/v1/models`,
  `/v1/runs*`, `/api/sessions*`, `/api/jobs*` with scripted SSE. Contract
  tests for each transport, 401/429 mapping, abort → `stop`, idempotency.

Exit criteria: a query from the phone with the `hermes` slot streams through
a real gateway on a dev box, tool status shows on the lens, cancel stops the
run, and the durable job reattaches after the app is backgrounded.

### 5.2 Phase 2 — Sessions, HUD prompt, profiles

**Sessions become Hermes sessions.** `conversation.ts` shrinks to an index:

```ts
interface GlassesSession {
  id: string            // what the phone already sends
  hermesSessionId: string
  profile: string
  title?: string
  createdAt: number
  lastActiveAt: number
}
```

- `getOrCreateSession()` creates a Hermes session (`POST /api/sessions`) on
  first use and stores the mapping in `sessions.json` (same file, new shape,
  one-time migration that keeps the old exchanges under `legacy/` for the
  archive view).
- "New chat" / context break → new Hermes session; old one gets
  `PATCH { end_reason: 'user_new_chat' }`.
- Session list and transcript views (`routes/sessions.ts`,
  `routes/session-index.ts`, message-ref) read `GET /api/sessions/{id}/messages`
  and cache the projection locally for the display bus. Message numbering
  (`message-era.ts`) stays local; it is a HUD concern.
- "Recall message N" (`PromptReference`) is sent as part of the user turn
  text, not as replayed history.
- Fork → `POST /api/sessions/{id}/fork`; exposed as `/api/sessions/:id/fork`
  for the phone.
- `openai-compat.ts` daily reset (`getOrResetG2Session`) → keep the rule but
  implement as "rotate Hermes session at local midnight". Point Hermes'
  `session_reset` at `none` for the API-server platform so only one side
  resets.
- `acquireModelSessionRunLock` in `model-router.ts` stays; Hermes serialises
  per session too, but the local lock prevents two 429-able submissions.

**HUD prompt.** New `hud-prompt.ts` replaces `buildSystemPrompt`,
`buildLightweightSystemPrompt`, `buildPrewarmSystemPrompt` and
`buildOllamaSystemPrompt`. It is sent as `instructions` and layered by Hermes
on top of SOUL:

```
You are answering on Even G2 smart glasses: a 576x288 monochrome display,
about 4 short lines visible at once, read while walking.
Lead with the answer in one or two lines. Plain text only: no markdown,
tables, code fences or emoji. Expand only when asked.
```

Plus optional runtime lines the server actually knows: local time zone, the
attached-photo notice, and the `[SILENT]`-style instruction for background
turns. No owner name, no calendar, no tasks; if Hermes wants those it has its
own tools and memory.

**Profiles replace the model picker.** New `hermes/profiles.ts` reads
`HERMES_PROFILES` (JSON array of `{ name, url, key, label }`) with a single
default entry synthesised from `HERMES_API_URL`/`HERMES_API_KEY`. Each entry is
probed for `/v1/models` at boot and every 15 min (same cadence as the old
Codex catalog).

- `GET /api/agent/profiles` → `[ { name, label, ready, model, skills: n,
  toolsets: [...] } ]` for the phone picker (reads `/v1/skills` and
  `/v1/toolsets` once per refresh).
- Per-session profile is stored on `GlassesSession.profile`; switching
  profiles mid-session starts a new Hermes session because sessions do not
  cross profiles.
- `shared/model-preference.ts` is replaced by `shared/agent-preference.ts`:
  `{ profile: string; effort: EffortPreference }`. `normalizeModelPreference`
  keeps accepting the legacy strings for one release and maps them all to the
  default profile so old phone builds still work.
- Multiplexed gateways (`gateway.multiplex_profiles`) are supported by
  allowing `url` to include a `/p/<profile>` prefix; the client just joins
  paths.

Exit criteria: phone shows profiles instead of models, session list comes
from Hermes, "new chat" produces a fresh Hermes session, no request carries
Cos text.

### 5.3 Phase 3 — Cron replaces morning brief and tasks

**Job CRUD proxy.** `hermes/jobs.ts` + `routes/jobs.ts` expose an
allowlisted subset of the Hermes Jobs API to the phone under `/api/jobs`:

| Phone route | Hermes | Notes |
|---|---|---|
| `GET /api/jobs` | `GET /api/jobs` | adds `profile`, strips `workdir`/script paths |
| `POST /api/jobs` | `POST /api/jobs` | body: `name, prompt, schedule, skills[], enabled_toolsets[], continuity, deliver` |
| `PATCH /api/jobs/:id` | `PATCH` | partial merge |
| `POST /api/jobs/:id/{pause,resume,run}` | same | `run` returns immediately; result arrives via inbox |
| `DELETE /api/jobs/:id` | same | |

Prompt-injection scanning and `model`/`provider` pins are Hermes' job; the
proxy never lets the phone set a per-job model, matching Hermes' own rule
that inference pins are user-owned. `no_agent` script jobs are not creatable
from the phone (they need a script on disk).

**Morning brief as a cron job.** `morning-brief-config.ts` becomes a
bootstrap that, on first run, creates one Hermes job:

- `name: "G2 morning brief"`, `schedule: "daily at 06:30"` (from the existing
  config), `skills: [...]` (whatever the profile has for calendar/tasks),
  `continuity: true` (dedupe against yesterday), `enabled_toolsets` tuned per
  profile, and a prompt that carries the HUD constraints (≤60 chars per line,
  ≤60 lines, plain text) that `morning-brief-prompt.ts:256` enforces today.
- `morning-brief-scheduler.ts`, `morning-brief-runtime.ts`,
  `morning-brief-coverage.ts`, and the Cos source adapters are deleted. The
  REST routes in `routes/morning-brief.ts` become thin wrappers over the job
  (`GET` = job + last run, `POST /run` = `run`, `PATCH` = schedule/prompt).

**Tasks as cron jobs.** `task-dispatcher.ts` / `task-store.ts` (restricted
read-only dispatch of scheduled prompts) map onto one-shot or recurring jobs
with `enabled_toolsets` restricted. Their `done_when` guard has no Hermes
equivalent; it becomes part of the prompt plus `continuity`.

**Inbox bridge (delivery to the glasses).** Hermes cannot deliver to G2. The
plan offers two mechanisms, chosen by config, both landing in a new
`hermes-inbox` display event on the display bus and a `GET /api/inbox`
list for the phone:

1. `HERMES_INBOX_MODE=poll` (default): after each job's `next_run_at` passes
   (from `GET /api/jobs/{id}`), fetch the job and read `last_run` output.
   Zero filesystem coupling, works across users/hosts, ~60 s latency.
2. `HERMES_INBOX_MODE=local`: watch `${HERMES_HOME}/cron/output/{job_id}/`
   with `fs.watch` when the gateway and this server share a host and user.
   Immediate, but requires co-location and readable `HERMES_HOME`.

`[SILENT]` runs produce no inbox entry. Failures do (Hermes always delivers
failures). Each inbox item is also pushed as a session-less display card, so
it appears on the lens without the phone asking.

Open verification: whether the current Hermes build offers an HTTP/webhook
delivery target (`hermes-webhook` appears in the platform toolset table). If
it does, add `HERMES_INBOX_MODE=webhook` with a token-authenticated
`POST /api/inbox/hermes` on this server and make it the default.

Exit criteria: morning brief arrives on the lens from a Hermes cron job with
no `morning-brief-scheduler` in-process; phone can pause/resume/run jobs.

### 5.4 Phase 4 — Launcher, health, config, operations

- `bin/cli.cjs`: delete the Claude/Codex/Cursor probes (`:194-361`) and the
  `hasUsableAgent` exit. Replace with a Hermes reachability check that prints
  the gateway URL, profile/model, and capabilities, and **warns but does not
  exit** if the gateway is down (the server is still useful for display,
  STT/TTS, meetings). `--setup-transcription` and `--setup-speaker-model`
  stay.
- `bin/managed-server.cjs` / `managed-runtime-contract.json`: remove
  provider-related fields; add `hermes.ready`.
- `routes/health.ts`: drop `health-static-probes.ts` CLI checks and
  `provider-proof.ts`; add the cached capabilities plus a bounded
  `GET /health/detailed` readout (status and counts only).
- `.env.example`: rewrite the LLM section to `HERMES_*`; delete every
  `COS_CLAUDE_*`, `COS_CODEX_*`, `COS_CURSOR_*`, `COS_OLLAMA_*`,
  `COS_SCRIPTS_DIR`, `COS_OPERATIONS_DIR` key; keep network, token, media,
  speech, durable-jobs keys.
- Ops notes (`docs/ops-hermes.md`, not deployed): `cos-glasses-server.service`
  gets `After=hermes-gateway.service` / `Wants=`; `cos-hermes-shim.service`
  and `/opt/cos-glasses/hermes-ollama-shim.cjs` are removed at cutover; the
  stub `/home/cos/bin/claude` is removed; `API_SERVER_HOST` stays `127.0.0.1`.
- `network-policy.ts` unchanged: `:3141` never leaves Tailscale/LAN.

### 5.5 Phase 5 — Delete Cos

Delete (with their tests):

| Group | Files |
|---|---|
| Provider bridges | `claude-bridge.ts`, `codex-bridge.ts`, `cursor-bridge.ts`, `ollama-bridge.ts`, `model-router.ts` (replaced by 30-line Hermes call) |
| Catalogs / sessions / ledgers | `codex-model-catalog.ts`, `codex-engine-sessions.ts`, `codex-extra-args.ts`, `codex-run-ledger.ts`, `cursor-model-catalog.ts`, `cursor-engine-sessions.ts`, `cursor-agent-store.ts`, `cursor-run-ledger.ts`, `claude-run-ledger.ts`, `claude-circuit.ts`, `claude-permissions.ts`, `claude-session-registry.ts`, `claude-tool-access.ts`, `banned-permission-args.ts`, `ollama-catalog.ts`, `ollama-run-ledger.ts`, `ollama-tools.ts`, `provider-binary.ts`, `provider-proof.ts`, `provider-terminal-error.ts`, `provider-process-lifecycle.ts`, `health-static-probes.ts` |
| Cos mind | `context-builder.ts`, `context-files.ts`, `context-library-search.ts`, `cos-context-browser.ts`, `python-bridge.ts`, `profile.ts` owner-name reads, `routes/welcome-context.ts`; `response-cache.ts` is trimmed to the time/date instant answers (the calendar patterns read Cos context) |
| Scheduling | `morning-brief-*.ts` (6 files), `task-dispatcher.ts`, `task-store.ts`, `routes/tasks.ts` |
| Desktop agent browsing | `agent-session-*.ts` (5), `attached-provider-adapter.ts`, `attached-workspace.ts`, `fork-thread.ts`, `thread-*.ts` (6), `occupancy-probes.ts`, `occupied-threads.ts`, `fence-liveness.ts`, `native-head.ts`, `native-thread-id.ts`, `stranded-session*.ts`, `session-stream-*.ts`, `session-transcript-watcher.ts`, `routes/agent-sessions.ts`, `routes/agent-session-bindings.ts`, `routes/agent-session-stream.ts`, `routes/claude-sessions.ts`, `routes/thread-turn-queue.ts`, `routes/threads.ts` |
| Cos Operations | `cos-operations-meetings.ts`, `g2-ops-handoff.ts`, `live-cues-*.ts` (5), `routes/live-cues.ts`, `telegram-notify.ts` (Hermes' own Telegram channel supersedes it) |

Rewire instead of delete:

- `dictation-clean.ts`, `prompt-edit.ts`, `archive.ts`, `meeting-summary.ts`
  currently `spawn('claude', ['-p', …])`. Add
  `hermes/utility.ts: completeOnce(instructions, input)` that calls
  `/v1/chat/completions` non-streaming with a throwaway
  `X-Hermes-Session-Id` and `enabled_toolsets: []` semantics via
  instructions ("answer from the text only"). Same budgets as today
  (`archive-budget.ts`, `meeting-summary-budget.ts`).
- `routes/memory.ts`: Hermes exposes no memory REST API. Replace the memory
  search route with a Hermes turn ("search your memory for …") in a
  throwaway session, or drop the route and let the user ask. Decision for
  Oscar; default is drop.
- `handoff-store.ts` / `routes/handoffs.ts`: keep the G2 ↔ desktop handoff
  shape but the `target` enum becomes `g2 | hermes-session`, implemented as
  `POST /api/sessions/{id}/fork` + title.

Identity strings: `rg -n "COS|Chief of Staff|gotcos" server shared bin` must
return only the package name, the token header (`X-Cos-Token`, kept for phone
compatibility), and env var prefixes (`COS_API_TOKEN`, `COS_DATA_DIR`, kept).
Everything else is renamed or removed. Package name becomes
`@oscarh30/glasses-server` (not published).

Expected size after Phase 5: roughly 55–60k lines including tests, from 130k.

### 5.6 Phase 6 — Even Hub contract and docs

The phone app is a separate Even Hub project. This phase only documents
what it can rely on, so the HUD work can start against a fake:

`docs/hud-api.md` — the stable server surface:

- Unchanged: `GET /api/health`, `GET /api/display-stream` (+ tickets),
  `POST /api/query-jobs` (202 + reattach), `POST /api/query` (legacy SSE),
  transcribe/TTS/media/meeting routes, `X-Cos-Token`.
- New: `GET /api/agent/profiles`, `GET/POST /api/sessions`,
  `POST /api/sessions/:id/fork`, `GET /api/sessions/:id/messages`,
  `/api/jobs*`, `GET /api/inbox`, display events `tool_status`
  (Hermes tool names), `hermes-inbox`, `approval_required`.
- New display event `approval_required` → phone renders yes/no →
  `POST /api/query-jobs/:id/approval` → `POST /v1/runs/{id}/approval`. Until
  the HUD supports it, the server auto-denies after 60 s and shows
  "Hermes needs approval; open the phone app."
- `/v1/chat/completions` on `:3141` remains for Even's built-in "Add Agent"
  and becomes a passthrough that injects the HUD instructions and the session
  headers; `/v1/models` advertises the configured profiles.

README and CHANGELOG get a `7.0.0` entry: Hermes-only, Cos removed, migration
notes (`COS_G2_DEFAULT_MODEL` ignored, `HERMES_API_KEY` required).

## 6. Testing strategy

- Unit/contract: the `fake-hermes` fixture drives every transport and error
  branch; tests assert no request body ever contains `You are COS`, an owner
  name, or replayed history.
- Capability matrix: fixture variants with `run_submission=false`,
  `session_*=false`, `session_key_header` absent, to prove the fallback
  ladder.
- Concurrency: two phone requests on one session → one Hermes run at a time;
  a 429 surfaces as a lens message with `Retry-After`.
- Durable jobs: submit, kill the SSE client, restart the server, reattach by
  `run_id`, receive terminal state.
- Cron: fixture job with `last_run` output → inbox card on the display bus;
  `[SILENT]` suppressed; failure delivered.
- Manual (dev box, not the VPS): `hermes profile create eve`, enable API
  server on `8643`, run this server, pair the phone over Tailscale, walk
  through chat / new chat / fork / brief.
- Existing `vitest.config.ts` isolation (`COS_DATA_DIR`) is kept; add
  `HERMES_API_URL=http://127.0.0.1:0` in test env so no test can reach a real
  gateway by accident.

## 7. Risks and open decisions

| # | Item | Proposed default | Needs Oscar |
|---|---|---|---|
| 1 | Hermes model id on `:8643` is the profile name, not `hermes-agent` | Read `/v1/models`; optionally set `API_SERVER_MODEL_NAME=hermes-agent` in the profile `.env` | No |
| 2 | Cron delivery to G2 has no native target | Poll mode; verify webhook target and switch if available | Yes: which mode |
| 3 | Memory search route has no Hermes REST equivalent | Drop `routes/memory.ts` | Yes |
| 4 | Agentic turns can exceed Even app timeouts | Runs API + keepalive comments + reattach; HUD shows tool status | No |
| 5 | Hermes API is moving (July 2026 auth change on `/p/<profile>/`) | Capabilities probe, `HERMES_MIN_VERSION` check from `/health/detailed` when available | No |
| 6 | Existing `sessions.json` history is not importable into Hermes | Keep read-only under `legacy/`; start fresh | Yes: OK to not migrate |
| 7 | `API_SERVER_KEY` grants terminal access | Only this server holds it; proxy allowlist; never returned to phone; never logged | No |
| 8 | Meetings/live-cues used Cursor Composer | Live cues deleted; meeting summary via `completeOnce` | Yes: confirm live cues can go |
| 9 | Package identity / upstream sync | Rename package, stop tracking upstream after 7.0.0 (diverged too far) | Yes |

## 8. Out of scope

- Writing a native Hermes gateway platform ("g2" adapter in Python). It
  would make G2 a first-class delivery target and remove the inbox bridge,
  but it lives in the Hermes repo, not here. Revisit after Phase 3.
- The Even Hub app itself.
- Deploying any of this to `100.87.43.24`.
