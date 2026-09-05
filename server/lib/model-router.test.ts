import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  hermesCallbacks: [] as any[],
  callHermesStreaming: vi.fn(async (_query: string, sid: string, callbacks: any) => {
    mocks.hermesCallbacks.push(callbacks)
    return sid
  }),
  sessionModels: new Map<string, string | null>(),
}))

vi.mock('./hermes/bridge.js', () => ({
  callHermesStreaming: mocks.callHermesStreaming,
}))

vi.mock('./conversation.js', () => ({
  getOrCreateSession: (sid?: string) => sid ?? 'generated-session',
  getSessionModel: (sid: string) => mocks.sessionModels.get(sid) ?? null,
  setSessionModel: (sid: string, model: string | null) => { mocks.sessionModels.set(sid, model) },
}))

import { callModelStreaming } from './model-router.js'

function callbacks() {
  return {
    onChunk: vi.fn(),
    onDone: vi.fn(),
    onError: vi.fn(),
  }
}

afterEach(() => {
  mocks.hermesCallbacks.length = 0
  mocks.callHermesStreaming.mockClear()
  mocks.sessionModels.clear()
})

describe('per-session Hermes run lock', () => {
  it('serializes turns in one session until the terminal callback fires', async () => {
    const firstCallbacks = callbacks()
    const secondCallbacks = callbacks()
    await callModelStreaming('first', 'same-session', firstCallbacks, 'sonnet')

    const second = callModelStreaming('second', 'same-session', secondCallbacks, 'sonnet')
    await Promise.resolve()
    expect(mocks.callHermesStreaming).toHaveBeenCalledTimes(1)

    await mocks.hermesCallbacks[0].onDone('first answer', 'hermes')
    await second
    expect(mocks.callHermesStreaming).toHaveBeenCalledTimes(2)
    await mocks.hermesCallbacks[1].onDone('second answer', 'hermes')
  })

  it('awaits an async terminal callback before starting the same-session successor', async () => {
    let releaseTerminal!: () => void
    const terminalGate = new Promise<void>(resolve => { releaseTerminal = resolve })
    const firstCallbacks = callbacks()
    firstCallbacks.onDone.mockImplementation(async () => { await terminalGate })

    await callModelStreaming('first', 'async-terminal-session', firstCallbacks, 'sonnet')
    const second = callModelStreaming('second', 'async-terminal-session', callbacks(), 'sonnet')
    await Promise.resolve()

    const terminal = mocks.hermesCallbacks[0].onDone('first answer', 'hermes')
    await Promise.resolve()
    expect(mocks.callHermesStreaming).toHaveBeenCalledTimes(1)

    releaseTerminal()
    await terminal
    await second
    expect(mocks.callHermesStreaming).toHaveBeenCalledTimes(2)
    await mocks.hermesCallbacks[1].onDone('second answer', 'hermes')
  })

  it('allows different sessions to run concurrently', async () => {
    await Promise.all([
      callModelStreaming('one', 'session-a', callbacks(), 'sonnet'),
      callModelStreaming('two', 'session-b', callbacks(), 'sonnet'),
    ])
    expect(mocks.callHermesStreaming).toHaveBeenCalledTimes(2)
    await mocks.hermesCallbacks[0].onDone('one', 'hermes')
    await mocks.hermesCallbacks[1].onDone('two', 'hermes')
  })

  it('drops an aborted queued turn without starting another Hermes turn', async () => {
    await callModelStreaming('first', 'abort-session', callbacks(), 'sonnet')
    const controller = new AbortController()
    controller.abort()
    const queued = callModelStreaming('never run', 'abort-session', callbacks(), 'sonnet', undefined, undefined, undefined, { abortSignal: controller.signal })

    await mocks.hermesCallbacks[0].onError('first failed')
    await expect(queued).rejects.toThrow('aborted before the model run')
    expect(mocks.callHermesStreaming).toHaveBeenCalledTimes(1)
  })

  it('releases the session after an early bridge rejection', async () => {
    mocks.callHermesStreaming.mockRejectedValueOnce(new Error('spawn failed early'))
    await expect(callModelStreaming('first', 'reject-session', callbacks(), 'sonnet')).rejects.toThrow('spawn failed early')

    await callModelStreaming('second', 'reject-session', callbacks(), 'sonnet')
    expect(mocks.callHermesStreaming).toHaveBeenCalledTimes(2)
    await mocks.hermesCallbacks[0].onDone('recovered', 'hermes')
  })

  it('routes every Cos slot through Hermes', async () => {
    await callModelStreaming('hi', 'ollama-session', callbacks(), 'ollama')
    expect(mocks.callHermesStreaming).toHaveBeenCalledTimes(1)
    await mocks.hermesCallbacks[0].onDone('local', 'hermes')
  })
})
