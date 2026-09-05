import { randomUUID } from 'node:crypto'
import type { CallOptions, StreamCallbacks } from '../claude-bridge.js'
import { getOrCreateSession } from '../conversation.js'
import { getHermesRuntime } from './runtime.js'

/** StreamCallbacks adapter over the g2 platform inbox. Used by legacy
 * `/api/query` and as a fallback when the Hermes API server is unconfigured. */
export async function callHermesStreaming(
  query: string,
  sessionId: string | undefined,
  callbacks: StreamCallbacks,
  _model?: string,
  _images?: unknown[],
  _reference?: { query: string; response: string },
  _globalMsgNum?: number,
  options?: CallOptions,
): Promise<string> {
  const runtime = getHermesRuntime()
  const sid = getOrCreateSession(sessionId)
  const profile = runtime.config.defaultProfile
  const correlationId = options?.clientJobId ?? `live_${randomUUID()}`

  if (options?.abortSignal?.aborted) {
    await callbacks.onError('Turn cancelled')
    return sid
  }

  const abort = () => {
    runtime.ledger.append(profile, 'stop', { correlationId, sessionId: sid })
    runtime.turns.fail(correlationId, new Error('Turn cancelled'))
  }
  options?.abortSignal?.addEventListener('abort', abort, { once: true })

  try {
    callbacks.onStart?.(profile as never, sid, undefined, { hermesRunId: correlationId } as never)
    await callbacks.onProviderProcess?.({
      provider: 'hermes',
      runId: correlationId,
      clientJobId: options?.clientJobId,
      generation: options?.jobGeneration ?? options?.generation,
    })
    runtime.ledger.append(profile, 'message', {
      id: correlationId,
      text: query,
      correlationId,
      sessionId: sid,
    })
    const waiting = runtime.turns.wait(correlationId, runtime.config.turnTimeoutMs)
    const stubReply = process.env.HERMES_STUB_REPLY
    if (stubReply) runtime.turns.complete(correlationId, { text: stubReply, kind: 'reply' })
    const result = await waiting
    callbacks.onChunk(result.text)
    await callbacks.onDone(result.text, 'hermes' as never, undefined, { hermesRunId: correlationId } as never)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await callbacks.onError(message)
  } finally {
    options?.abortSignal?.removeEventListener('abort', abort)
  }
  return sid
}
