// OpenAI-compatible /v1/chat/completions — Even Realities "Add Agent" (Tier 3).
// Passthrough to the Hermes API server. Cos model ids remain accepted aliases
// for one release and resolve to the default Hermes profile.

import { Router } from 'express'
import crypto from 'node:crypto'
import { timingSafeTokenEqual } from '../lib/token-auth.js'
import {
  acquireMaintenanceWork,
  MaintenanceLifecycleError,
  type MaintenanceWorkLease,
} from '../lib/maintenance-lifecycle.js'
import { tryInstantResponse } from '../lib/response-cache.js'
import { hermesChatCompletions, listHermesModels } from '../lib/hermes/api-client.js'
import { loadHermesConfig } from '../lib/hermes/config.js'
import { normalizeAgentPreference } from '../../shared/agent-preference.js'
import { normalizeModelPreference, DEFAULT_MODEL, type ModelPreference } from '../../shared/model-preference.js'
import {
  getCodexModelCatalog,
  resolveCodexPreferenceForModelId,
} from '../lib/codex-model-catalog.js'
import { resolveCursorPreferenceForModelId } from '../lib/cursor-model-catalog.js'

export const openaiCompatRouter = Router()

const inflightQueries = new Map<string, { promise: Promise<string>; timestamp: number }>()
const DEDUP_WINDOW_MS = 2000

function cleanupInflight() {
  const now = Date.now()
  for (const [key, entry] of inflightQueries) {
    if (now - entry.timestamp > 30_000) inflightQueries.delete(key)
  }
}

let g2SessionSuffix = ''
let g2SessionDate: string | undefined

function hermesDaySession(query: string): { sessionId: string; sessionKey: string } {
  const today = new Date().toISOString().slice(0, 10)
  if (g2SessionDate !== today) {
    g2SessionDate = today
    g2SessionSuffix = ''
  }
  if (/\b(reset session|new session|fresh start|clear context|start over)\b/i.test(query)) {
    g2SessionSuffix = `-${Date.now()}`
  }
  const config = loadHermesConfig()
  return {
    sessionId: `g2-${today}${g2SessionSuffix}`,
    sessionKey: `${config.sessionKeyPrefix}:${config.defaultProfile}`,
  }
}

function validateAuth(req: any, res: any): boolean {
  const cosToken = process.env.COS_API_TOKEN
  if (!cosToken) return true

  const auth = req.headers['authorization']
  if (!auth || !auth.startsWith('Bearer ')) {
    res.status(401).json({ error: { message: 'Missing Bearer token', type: 'invalid_request_error' } })
    return false
  }
  if (!timingSafeTokenEqual(auth.slice(7), cosToken)) {
    res.status(401).json({ error: { message: 'Invalid token', type: 'invalid_request_error' } })
    return false
  }
  return true
}

export function selectOpenAICompatibleModel(
  bodyModel?: string,
  urlModel?: string,
): string | undefined {
  const fromUrl = urlModel?.trim()
  if (fromUrl) return fromUrl
  const fromBody = bodyModel?.trim()
  return fromBody || undefined
}

export function resolveModel(model?: string, _query?: string): ModelPreference {
  const normalized = normalizeModelPreference(model)
  if (normalized) return normalized
  if (model) {
    const catalogPreference = resolveCodexPreferenceForModelId(model)
    if (catalogPreference) return catalogPreference
    const cursorPreference = resolveCursorPreferenceForModelId(model)
    if (cursorPreference) return cursorPreference
  }
  if (model === 'cos-opus') return 'opus'
  if (model === 'cos-fable') return 'fable'
  if (model === 'cos-sonnet') return 'sonnet'
  if (model === 'cos-haiku') return 'haiku'
  if (model === 'cos-gpt-frontier' || model === 'cos-codex-high' || model === 'cos-codex') return 'codex-frontier'
  if (model === 'cos-gpt-balanced') return 'codex-balanced'
  if (model === 'cos-ollama' || model === 'ollama') return 'ollama'
  return normalizeModelPreference(process.env.COS_G2_DEFAULT_MODEL) ?? DEFAULT_MODEL
}

function resolveHermesProfile(model?: string): string {
  return normalizeAgentPreference(model).profile
}

function extractUserQuery(messages: Array<{ role: string; content: unknown }>): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const row = messages[i]
    if (row.role !== 'user') continue
    if (typeof row.content === 'string' && row.content) return row.content
    if (Array.isArray(row.content)) {
      const text = row.content
        .filter((part): part is { type: 'text'; text: string } => part && part.type === 'text' && typeof part.text === 'string')
        .map(part => part.text)
        .join('\n')
        .trim()
      if (text) return text
    }
  }
  return ''
}

function writeStreamText(
  res: { write: (chunk: string) => void; end: () => void },
  completionId: string,
  timestamp: number,
  responseModel: string,
  text: string,
): void {
  res.write(`data: ${JSON.stringify({
    id: completionId,
    object: 'chat.completion.chunk',
    created: timestamp,
    model: responseModel,
    choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
  })}\n\n`)
  res.write(`data: ${JSON.stringify({
    id: completionId,
    object: 'chat.completion.chunk',
    created: timestamp,
    model: responseModel,
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
  })}\n\n`)
  res.write('data: [DONE]\n\n')
}

openaiCompatRouter.post('/v1/chat/completions', async (req, res) => {
  if (!validateAuth(req, res)) return

  const { messages, stream, model } = req.body
  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({
      error: { message: 'messages array required', type: 'invalid_request_error' },
    })
  }

  const query = extractUserQuery(messages)
  if (!query) {
    return res.status(400).json({
      error: { message: 'No user message found', type: 'invalid_request_error' },
    })
  }

  let maintenanceLease: MaintenanceWorkLease
  try {
    maintenanceLease = acquireMaintenanceWork('openai_query')
  } catch (error) {
    if (error instanceof MaintenanceLifecycleError) {
      if (error.retryAfterSeconds != null) res.setHeader('Retry-After', String(error.retryAfterSeconds))
      return res.status(error.status).json({
        error: {
          message: error.message,
          type: 'server_error',
          code: error.code,
          retryable: error.retryable,
        },
      })
    }
    throw error
  }

  const selectedModel = selectOpenAICompatibleModel(
    model,
    typeof req.query.model === 'string' ? req.query.model : undefined,
  )
  const profile = resolveHermesProfile(selectedModel)
  const completionId = `chatcmpl-${crypto.randomUUID().slice(0, 12)}`
  const timestamp = Math.floor(Date.now() / 1000)
  const responseModel = profile

  const cached = tryInstantResponse(query)
  if (cached) {
    if (stream) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
        'Access-Control-Allow-Origin': '*',
      })
      res.flushHeaders()
      writeStreamText(res, completionId, timestamp, responseModel, cached.text)
      res.end()
      maintenanceLease.release()
      return
    }
    const response = res.json({
      id: completionId,
      object: 'chat.completion',
      created: timestamp,
      model: responseModel,
      choices: [{ index: 0, message: { role: 'assistant', content: cached.text }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    })
    maintenanceLease.release()
    return response
  }

  cleanupInflight()
  const dedupKey = `${profile}:${query.trim().toLowerCase()}`
  const inflight = inflightQueries.get(dedupKey)
  if (inflight && (Date.now() - inflight.timestamp) < DEDUP_WINDOW_MS) {
    try {
      const dedupResult = await inflight.promise
      if (stream) {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
          'Access-Control-Allow-Origin': '*',
        })
        res.flushHeaders()
        writeStreamText(res, completionId, timestamp, responseModel, dedupResult)
        res.end()
        maintenanceLease.release()
        return
      }
      const response = res.json({
        id: completionId,
        object: 'chat.completion',
        created: timestamp,
        model: responseModel,
        choices: [{ index: 0, message: { role: 'assistant', content: dedupResult }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      })
      maintenanceLease.release()
      return response
    } catch {
      /* fall through */
    }
  }

  let resolveInflight!: (text: string) => void
  let rejectInflight!: (err: unknown) => void
  const inflightPromise = new Promise<string>((resolve, reject) => {
    resolveInflight = resolve
    rejectInflight = reject
  })
  void inflightPromise.catch(() => {})
  inflightQueries.set(dedupKey, { promise: inflightPromise, timestamp: Date.now() })

  const providerAbort = new AbortController()
  let responseFinished = false
  let clientDisconnected = false
  res.once('finish', () => { responseFinished = true })
  res.once('close', () => {
    if (responseFinished) return
    clientDisconnected = true
    providerAbort.abort(new Error('G2 client disconnected'))
  })

  const session = hermesDaySession(query)
  const runCompletion = () => hermesChatCompletions({
    messages: [{ role: 'user', content: query }],
    sessionId: session.sessionId,
    sessionKey: session.sessionKey,
    model: profile,
  }, providerAbort.signal)

  if (stream) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      'Access-Control-Allow-Origin': '*',
    })
    res.flushHeaders()
    res.write(': keepalive\n\n')
    try {
      const result = await runCompletion()
      resolveInflight(result.text)
      inflightQueries.delete(dedupKey)
      if (!clientDisconnected) {
        writeStreamText(res, completionId, timestamp, result.model || responseModel, result.text)
        res.end()
      }
    } catch (err: any) {
      rejectInflight(err)
      inflightQueries.delete(dedupKey)
      if (!clientDisconnected) {
        res.write(`data: ${JSON.stringify({ error: { message: err.message } })}\n\n`)
        res.write('data: [DONE]\n\n')
        res.end()
      }
    } finally {
      maintenanceLease.release()
    }
    return
  }

  try {
    const result = await runCompletion()
    resolveInflight(result.text)
    inflightQueries.delete(dedupKey)
    if (!clientDisconnected) {
      res.json({
        id: result.id || completionId,
        object: 'chat.completion',
        created: timestamp,
        model: result.model || responseModel,
        choices: [{
          index: 0,
          message: { role: 'assistant', content: result.text },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      })
    }
  } catch (err: any) {
    rejectInflight(err)
    inflightQueries.delete(dedupKey)
    if (!clientDisconnected) {
      res.status(500).json({
        error: { message: err.message, type: 'server_error' },
      })
    }
  } finally {
    maintenanceLease.release()
  }
})

openaiCompatRouter.get('/v1/models', async (_req, res) => {
  const models = await listHermesModels()
  const catalog = await getCodexModelCatalog().catch(() => ({ options: [] as Array<{ id?: string }> }))
  res.json({
    object: 'list',
    data: [
      ...models.map(model => ({
        id: model.id,
        object: 'model',
        created: 1_709_251_200,
        owned_by: 'hermes',
      })),
      { id: 'cos-sonnet', object: 'model', created: 1_709_251_200, owned_by: 'hermes' },
      { id: 'cos-opus', object: 'model', created: 1_709_251_200, owned_by: 'hermes' },
      { id: 'cos-haiku', object: 'model', created: 1_709_251_200, owned_by: 'hermes' },
      ...catalog.options.filter(option => option.id).map(option => ({
        id: option.id,
        object: 'model',
        created: 1_709_251_200,
        owned_by: 'hermes',
      })),
    ],
  })
})
