import express from 'express'
import type { Server } from 'node:http'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { hermesPhoneRouter, hermesPluginRouter } from '../../routes/hermes-platform.js'
import { __resetDisplayBusForTests } from '../display-bus.js'
import { resetHermesConfigForTests } from './config.js'
import { resetHermesRuntimeForTests, getHermesRuntime } from './runtime.js'
import { runHermesPlatformTurn } from './turn-runner.js'

const TOKEN = 'test-hermes-plugin-token'

function pluginApp(): express.Express {
  const app = express()
  app.use(express.json())
  app.use('/hermes', hermesPluginRouter)
  app.use('/api', hermesPhoneRouter)
  return app
}

async function listen(app: express.Express): Promise<{ server: Server; base: string }> {
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s))
  })
  const addr = server.address()
  const port = typeof addr === 'object' && addr ? addr.port : 0
  return { server, base: `http://127.0.0.1:${port}` }
}

function auth(headers: Record<string, string> = {}): Record<string, string> {
  return { Authorization: `Bearer ${TOKEN}`, ...headers }
}

describe('Hermes g2 platform protocol', () => {
  beforeEach(() => {
    process.env.HERMES_PLUGIN_TOKEN = TOKEN
    process.env.HERMES_DEFAULT_PROFILE = 'eve'
    delete process.env.HERMES_STUB_REPLY
    resetHermesConfigForTests()
    resetHermesRuntimeForTests()
    __resetDisplayBusForTests()
  })

  afterEach(() => {
    resetHermesRuntimeForTests()
    resetHermesConfigForTests()
  })

  it('rejects a missing plugin token', async () => {
    const { server, base } = await listen(pluginApp())
    try {
      const response = await fetch(`${base}/hermes/health`)
      expect(response.status).toBe(401)
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })

  it('answers /hermes/health with the plugin token', async () => {
    const { server, base } = await listen(pluginApp())
    try {
      const response = await fetch(`${base}/hermes/health`, { headers: auth() })
      expect(response.status).toBe(200)
      const body = await response.json() as { platform?: string; defaultProfile?: string }
      expect(body.platform).toBe('g2')
      expect(body.defaultProfile).toBe('eve')
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })

  it('delivers a cron message into the inbox and phone list', async () => {
    const { server, base } = await listen(pluginApp())
    try {
      const delivered = await fetch(`${base}/hermes/deliver`, {
        method: 'POST',
        headers: auth({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ text: 'Morning brief ready', kind: 'cron', profile: 'eve' }),
      })
      expect(delivered.status).toBe(200)
      const inbox = await fetch(`${base}/api/inbox`)
      expect(inbox.status).toBe(200)
      const body = await inbox.json() as { items: Array<{ text: string; kind: string }> }
      expect(body.items).toHaveLength(1)
      expect(body.items[0]?.text).toBe('Morning brief ready')
      expect(body.items[0]?.kind).toBe('cron')
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })

  it('correlates a platform deliver to a waiting durable turn', async () => {
    const runtime = getHermesRuntime()
    const finished = runHermesPlatformTurn({
      jobId: 'job-1',
      turnId: 'turn-1',
      request: {
        query: 'what is next',
        sessionId: 'sess-1',
        attachmentIds: [],
        attachmentRefs: [],
        activityToolMode: 'status',
        clientJobId: '00000000-0000-4000-8000-000000000001',
        generation: 1,
        messageEra: 'era-1',
      } as never,
      signal: new AbortController().signal,
      callbacks: {
        onStart: async () => {},
        onProviderProcess: async () => true,
        onChunk: () => {},
        onToolStatus: () => {},
        onActivityLine: () => {},
        onAnswerReady: async () => true,
        onDone: async (completion) => {
          expect(completion.text).toBe('Stand up at 3.')
          expect(completion.provider).toBe('hermes')
          return true
        },
        onError: async () => true,
      },
    })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(runtime.ledger.latestId('eve')).toBeGreaterThan(0)
    runtime.turns.complete('job-1', { text: 'Stand up at 3.', kind: 'reply' })
    await finished
  })

  it('presents an approval and resolves it from the phone route', async () => {
    const { server, base } = await listen(pluginApp())
    try {
      const presented = await fetch(`${base}/hermes/approval`, {
        method: 'POST',
        headers: auth({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          request_id: 'apr-1',
          digest: 'x',
          command: 'send_email',
          description: 'Send the draft to Alex?',
          choices: ['once', 'deny'],
          timeout_s: 30,
        }),
      })
      expect(presented.status).toBe(200)
      const wait = fetch(`${base}/hermes/approval/apr-1`, { headers: auth() })
      const decided = await fetch(`${base}/api/approvals/apr-1`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ choice: 'once' }),
      })
      expect(decided.status).toBe(200)
      const waited = await wait
      expect(waited.status).toBe(200)
      expect(await waited.json()).toEqual({ choice: 'once' })
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })

  it('replays inbound events after Last-Event-ID', async () => {
    const runtime = getHermesRuntime()
    const first = runtime.ledger.append('eve', 'message', { id: 'm1', text: 'hello', correlationId: 'c1' })
    const { server, base } = await listen(pluginApp())
    try {
      const controller = new AbortController()
      const response = await fetch(`${base}/hermes/stream?profile=eve`, {
        headers: auth({ 'Last-Event-ID': String(first.id - 1) }),
        signal: controller.signal,
      })
      expect(response.status).toBe(200)
      const reader = response.body!.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      while (!buffer.includes('hello')) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
      }
      controller.abort()
      expect(buffer).toContain('hello')
      expect(buffer).toContain('event: message')
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })

  it('lists the default profile on the phone picker', async () => {
    const { server, base } = await listen(pluginApp())
    try {
      getHermesRuntime().profiles.subscribe('eve')
      const response = await fetch(`${base}/api/agent/profiles`)
      expect(response.status).toBe(200)
      const body = await response.json() as { defaultProfile: string; profiles: Array<{ name: string; connected: boolean }> }
      expect(body.defaultProfile).toBe('eve')
      expect(body.profiles.some(row => row.name === 'eve' && row.connected)).toBe(true)
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })
})
