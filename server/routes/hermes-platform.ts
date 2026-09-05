import { Router } from 'express'
import { timingSafeTokenEqual } from '../lib/token-auth.js'
import { getHermesRuntime } from '../lib/hermes/runtime.js'
import { isLoopbackAddress } from '../lib/hermes/config.js'
import type { HermesInboxKind } from '../lib/hermes/inbox.js'
import type { HermesApprovalChoice } from '../lib/hermes/approvals.js'

function clientAddress(req: { ip?: string; socket: { remoteAddress?: string } }): string {
  return req.ip || req.socket.remoteAddress || ''
}

function requirePluginAuth(req: { ip?: string; socket: { remoteAddress?: string }; headers: Record<string, unknown> }, res: { status: (code: number) => { json: (body: unknown) => unknown } }, next: () => void): void {
  const runtime = getHermesRuntime()
  if (!isLoopbackAddress(clientAddress(req))) {
    res.status(403).json({ error: 'forbidden', reason: 'hermes_plugin_loopback_only' })
    return
  }
  const header = req.headers.authorization
  const token = typeof header === 'string' && header.startsWith('Bearer ')
    ? header.slice(7)
    : ''
  if (!timingSafeTokenEqual(token, runtime.config.pluginToken)) {
    res.status(401).json({ error: 'unauthorized', reason: 'hermes_plugin_token_rejected' })
    return
  }
  next()
}

function profileFrom(req: { query: Record<string, unknown>; body?: Record<string, unknown> }): string {
  const fromQuery = typeof req.query.profile === 'string' ? req.query.profile.trim() : ''
  const fromBody = typeof req.body?.profile === 'string' ? req.body.profile.trim() : ''
  return fromQuery || fromBody || getHermesRuntime().config.defaultProfile
}

export const hermesPluginRouter = Router()
hermesPluginRouter.use(requirePluginAuth)

hermesPluginRouter.get('/health', (_req, res) => {
  const runtime = getHermesRuntime()
  res.json({
    status: 'ok',
    platform: 'g2',
    defaultProfile: runtime.config.defaultProfile,
    profiles: runtime.profiles.list(),
  })
})

hermesPluginRouter.get('/stream', (req, res) => {
  const runtime = getHermesRuntime()
  const profile = profileFrom(req)
  runtime.profiles.ensure(profile)
  runtime.profiles.subscribe(profile)

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
  res.flushHeaders()
  res.write(': keepalive\n\n')

  const lastRaw = req.headers['last-event-id']
  const lastId = typeof lastRaw === 'string' ? Number(lastRaw) : 0
  const replayFrom = Number.isFinite(lastId) ? lastId : 0
  for (const event of runtime.ledger.replay(profile, replayFrom)) {
    res.write(`id: ${event.id}\nevent: ${event.kind}\ndata: ${JSON.stringify({ ...event.payload, profile, at: event.at })}\n\n`)
  }

  const heartbeat = setInterval(() => {
    runtime.profiles.heartbeat(profile)
    const keep = runtime.ledger.append(profile, 'keepalive', {})
    if (!res.writableEnded) res.write(`id: ${keep.id}\nevent: keepalive\ndata: {}\n\n`)
  }, 15_000)
  heartbeat.unref?.()

  const unsubscribe = runtime.ledger.onEvent(event => {
    if (event.profile !== profile) return
    if (event.kind === 'keepalive') return
    if (!res.writableEnded) {
      res.write(`id: ${event.id}\nevent: ${event.kind}\ndata: ${JSON.stringify({ ...event.payload, profile, at: event.at })}\n\n`)
    }
  })

  const cleanup = () => {
    clearInterval(heartbeat)
    unsubscribe()
    runtime.profiles.unsubscribe(profile)
  }
  res.once('close', cleanup)
  res.once('finish', cleanup)
})

hermesPluginRouter.post('/deliver', (req, res) => {
  const runtime = getHermesRuntime()
  const body = (req.body ?? {}) as Record<string, unknown>
  const text = typeof body.text === 'string' ? body.text.trim() : ''
  const kind = (body.kind === 'cron' || body.kind === 'notice' || body.kind === 'progress' || body.kind === 'reply')
    ? body.kind as HermesInboxKind
    : 'reply'
  if (!text && kind !== 'progress') {
    return res.status(400).json({ error: 'text required' })
  }
  const profile = profileFrom(req)
  const correlationId = typeof body.correlation_id === 'string' ? body.correlation_id : undefined
  const item = runtime.inbox.deliver({
    profile,
    kind,
    text,
    ...(correlationId ? { correlationId } : {}),
    ...(typeof body.reply_to === 'string' ? { replyTo: body.reply_to } : {}),
  })
  if (correlationId && kind !== 'progress') {
    runtime.turns.complete(correlationId, { text, kind: kind === 'notice' ? 'notice' : kind === 'cron' ? 'cron' : 'reply' })
  }
  res.json({ message_id: item.id })
})

hermesPluginRouter.post('/approval', (req, res) => {
  const runtime = getHermesRuntime()
  const body = (req.body ?? {}) as Record<string, unknown>
  const requestId = typeof body.request_id === 'string' ? body.request_id.trim() : ''
  if (!requestId) return res.status(400).json({ error: 'request_id required' })
  const choices = Array.isArray(body.choices) ? body.choices.filter((c): c is HermesApprovalChoice => typeof c === 'string') : []
  const request = runtime.approvals.present({
    requestId,
    digest: typeof body.digest === 'string' ? body.digest : '',
    command: typeof body.command === 'string' ? body.command : '',
    description: typeof body.description === 'string' ? body.description : '',
    choices,
    timeoutS: typeof body.timeout_s === 'number' ? body.timeout_s : 60,
    origin: typeof body.origin === 'string' ? body.origin : undefined,
    profile: profileFrom(req),
  })
  res.json({ request_id: request.requestId, expires_at: request.expiresAt })
})

hermesPluginRouter.get('/approval/:requestId', async (req, res) => {
  const runtime = getHermesRuntime()
  const requestId = String(req.params.requestId ?? '')
  const pending = runtime.approvals.get(requestId)
  if (!pending) return res.status(404).json({ error: 'not_found' })
  const remaining = Math.max(1, pending.expiresAt - Date.now())
  const choice = await Promise.race([
    runtime.approvals.wait(requestId),
    new Promise<null>(resolve => setTimeout(() => resolve(null), remaining)),
  ])
  if (!choice) return res.status(408).json({ error: 'timeout' })
  res.json({ choice })
})

hermesPluginRouter.post('/typing', (req, res) => {
  const runtime = getHermesRuntime()
  const on = (req.body as { on?: unknown } | undefined)?.on === true
  runtime.profiles.heartbeat(profileFrom(req))
  res.json({ ok: true, on })
})

export const hermesPhoneRouter = Router()

hermesPhoneRouter.get('/inbox', (req, res) => {
  const runtime = getHermesRuntime()
  const since = typeof req.query.since === 'string' ? req.query.since : undefined
  res.json({ items: runtime.inbox.list(since) })
})

hermesPhoneRouter.post('/inbox/:id/read', (req, res) => {
  const runtime = getHermesRuntime()
  const item = runtime.inbox.markRead(String(req.params.id ?? ''))
  if (!item) return res.status(404).json({ error: 'not_found' })
  res.json({ item })
})

hermesPhoneRouter.post('/approvals/:id', (req, res) => {
  const runtime = getHermesRuntime()
  const choice = typeof (req.body as { choice?: unknown } | undefined)?.choice === 'string'
    ? (req.body as { choice: string }).choice
    : ''
  const decided = runtime.approvals.decide(String(req.params.id ?? ''), choice)
  if (!decided) return res.status(404).json({ error: 'not_found_or_invalid_choice' })
  res.json({ choice: decided })
})

hermesPhoneRouter.get('/agent/profiles', (_req, res) => {
  const runtime = getHermesRuntime()
  res.json({
    defaultProfile: runtime.config.defaultProfile,
    profiles: runtime.profiles.list(),
  })
})
