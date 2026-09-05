# Eve Hub app contract

The Even Hub app is a separate repo. This is the server surface it can rely on.
Designed for a **resident dashboard** on iPhone: launch once, leave it running;
the WebView survives a locked phone. On `FOREGROUND_ENTER_EVENT` reconnect and
replay. Root double-tap must call `shutDownPageContainer(1)`.

## Auth

- Pairing token header: `X-Cos-Token`
- Display stream: ticket URL from authenticated `/api/health` (or equivalent
  ticket mint). Ticketless subscribers get lifecycle only.

## Unchanged

- `GET /api/health`
- `GET /api/display-stream` and ticketed variant
- `POST /api/query-jobs` (202 + reattach)
- `POST /api/query` (legacy SSE)
- transcribe / TTS / media / meeting routes

## New

- `GET /api/agent/profiles` → `{ defaultProfile, profiles: [{ name, label, connected, lastSeen }] }`
- `GET /api/inbox?since=<inboxId>`
- `POST /api/inbox/:id/read`
- `POST /api/approvals/:id` `{ choice: "once" | "session" | "always" | "deny" }`

## Display events (content requires a ticket)

- `hermes_message` — unsolicited or completed agent text (`inboxId`, `profile`, `kind`, `text`)
- `approval_required` — Hermes tool-approval prompt
- `approval_resolved`
- `agent_status` — `working` | `idle`
- existing `start` / `chunk` / `done` / `error` / `tool_status`

## Resident-dashboard rules

1. Persist `inbox` cursor and selected profile in `localStorage`.
2. On `FOREGROUND_ENTER_EVENT`: reconnect the display stream, `GET /api/inbox?since=<cursor>`, render the newest card.
3. On `FOREGROUND_EXIT_EVENT`: do nothing on iOS.
4. Approvals: list row plus contextual-menu Approve / Deny / Always.
5. Voice: glasses mic → `/api/transcribe-stream` → `/api/query-jobs`.
6. Chat commands (`/new`, `/sessions`, `/cron list`) are ordinary query-job text.

## Plugin-facing (not for the phone)

`/hermes/*` is loopback + `HERMES_PLUGIN_TOKEN` only. The Hub app never calls it.
