import { assertLoopbackApiUrl, loadHermesConfig } from './config.js'

export interface HermesChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string | Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }>
}

export interface HermesChatRequest {
  messages: HermesChatMessage[]
  sessionId?: string
  sessionKey?: string
  model?: string
  stream?: boolean
}

export interface HermesChatResult {
  text: string
  model: string
  id: string
}

function headers(apiKey: string, sessionId?: string, sessionKey?: string): Record<string, string> {
  const next: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  }
  if (sessionId) next['X-Hermes-Session-Id'] = sessionId
  if (sessionKey) next['X-Hermes-Session-Key'] = sessionKey
  return next
}

export async function hermesChatCompletions(
  request: HermesChatRequest,
  signal?: AbortSignal,
): Promise<HermesChatResult> {
  const config = loadHermesConfig()
  if (!config.apiUrl || !config.apiKey) {
    throw new Error('Hermes API server is not configured. Set HERMES_API_URL and HERMES_API_KEY.')
  }
  assertLoopbackApiUrl(config.apiUrl)
  const response = await fetch(`${config.apiUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: headers(config.apiKey, request.sessionId, request.sessionKey),
    body: JSON.stringify({
      model: request.model || config.defaultProfile,
      messages: request.messages,
      stream: false,
    }),
    signal,
  })
  if (!response.ok) {
    const detail = (await response.text().catch(() => '')).trim().slice(0, 240)
    if (response.status === 401) throw new Error('Hermes API key rejected.')
    if (response.status === 429) throw new Error('Hermes is busy. Try again shortly.')
    throw new Error(detail || `Hermes API HTTP ${response.status}`)
  }
  const body = await response.json() as {
    id?: string
    model?: string
    choices?: Array<{ message?: { content?: string } }>
  }
  const text = body.choices?.[0]?.message?.content?.trim() ?? ''
  if (!text) throw new Error('Hermes completed without a response.')
  return { text, model: body.model || config.defaultProfile, id: body.id || 'chatcmpl-hermes' }
}

export async function completeOnce(instructions: string, input: string, signal?: AbortSignal): Promise<string> {
  const result = await hermesChatCompletions({
    sessionId: `utility-${Date.now()}`,
    messages: [
      { role: 'system', content: `${instructions}\nAnswer from the supplied text only. Do not use tools.` },
      { role: 'user', content: input },
    ],
  }, signal)
  return result.text
}

export async function listHermesModels(): Promise<Array<{ id: string }>> {
  const config = loadHermesConfig()
  if (!config.apiUrl || !config.apiKey) {
    return [{ id: config.defaultProfile }]
  }
  assertLoopbackApiUrl(config.apiUrl)
  try {
    const response = await fetch(`${config.apiUrl}/v1/models`, {
      headers: { Authorization: `Bearer ${config.apiKey}` },
    })
    if (!response.ok) return [{ id: config.defaultProfile }]
    const body = await response.json() as { data?: Array<{ id?: string }> }
    const ids = (body.data ?? []).map(row => row.id).filter((id): id is string => typeof id === 'string' && id.trim() !== '')
    return ids.length > 0 ? ids.map(id => ({ id })) : [{ id: config.defaultProfile }]
  } catch {
    return [{ id: config.defaultProfile }]
  }
}
