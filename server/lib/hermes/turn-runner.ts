import { getOrCreateSession } from '../conversation.js'
import type { QueryJobRunner } from '../query-job-coordinator.js'
import { emitDisplay } from '../display-bus.js'
import { getHermesRuntime } from './runtime.js'

function originStamp(origin: { kind: string; id: string } | undefined): Record<string, unknown> {
  return origin ? { origin: origin.kind, originId: origin.id } : {}
}

export const runHermesPlatformTurn: QueryJobRunner = async ({
  jobId,
  turnId,
  request,
  signal,
  callbacks,
}) => {
  const runtime = getHermesRuntime()
  const profile = (typeof request.model === 'string' && request.model.trim() && !isLegacyModelSlot(request.model))
    ? request.model.trim()
    : runtime.config.defaultProfile
  runtime.profiles.ensure(profile)
  const sessionId = getOrCreateSession(request.sessionId)

  const text = request.query.trim()
  if (!text && request.attachmentRefs.length === 0) {
    await callbacks.onError('query string or attachment required')
    return
  }

  if (request.attachmentRefs.some(ref => ref.kind !== 'user_photo')) {
    await callbacks.onError('Only photos can be attached.')
    return
  }

  const abort = () => {
    runtime.ledger.append(profile, 'stop', { correlationId: jobId, sessionId })
    runtime.turns.fail(jobId, new Error('Turn cancelled'))
  }
  if (signal.aborted) {
    await callbacks.onError('Turn cancelled')
    return
  }
  signal.addEventListener('abort', abort, { once: true })

  try {
    await callbacks.onStart({ sessionId, provider: 'hermes', resolvedModel: profile })
    emitDisplay({
      type: 'start',
      data: {
        jobId,
        clientJobId: request.clientJobId,
        generation: request.generation,
        turnId,
        messageEra: request.messageEra,
        globalMsgNum: request.globalMsgNum,
        model: profile,
        sessionId,
        provider: 'hermes',
        ...originStamp(request.origin),
      },
    })
    emitDisplay({ type: 'agent_status', data: { profile, status: 'working', jobId } })

    const owned = await callbacks.onProviderProcess({
      provider: 'hermes',
      resolvedModel: profile,
    })
    if (!owned) return

    runtime.ledger.append(profile, 'message', {
      id: jobId,
      text: text || 'Describe the attached photo.',
      correlationId: jobId,
      sessionId,
      attachments: request.attachmentRefs.map(ref => ({
        id: ref.id,
        kind: ref.kind,
        url: `http://127.0.0.1:${process.env.PORT || '3141'}/api/media/${ref.id}/content?plugin=1`,
      })),
      replyTo: request.reference?.query,
    })

    const waiting = runtime.turns.wait(jobId, runtime.config.turnTimeoutMs)
    const stubReply = process.env.HERMES_STUB_REPLY
    if (stubReply) runtime.turns.complete(jobId, { text: stubReply, kind: 'reply' })
    const result = await waiting
    const terminalOwned = await callbacks.onDone({
      text: result.text,
      provider: 'hermes',
      resolvedModel: profile,
    })
    if (!terminalOwned) return
    emitDisplay({
      type: 'done',
      data: {
        jobId,
        clientJobId: request.clientJobId,
        generation: request.generation,
        turnId,
        messageEra: request.messageEra,
        globalMsgNum: request.globalMsgNum,
        text: result.text,
        sessionId,
        model: profile,
        provider: 'hermes',
        ...originStamp(request.origin),
      },
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const terminalOwned = await callbacks.onError(message)
    if (!terminalOwned) return
    emitDisplay({
      type: 'error',
      data: {
        jobId,
        clientJobId: request.clientJobId,
        generation: request.generation,
        turnId,
        messageEra: request.messageEra,
        globalMsgNum: request.globalMsgNum,
        error: message,
        ...originStamp(request.origin),
      },
    })
  } finally {
    signal.removeEventListener('abort', abort)
    emitDisplay({ type: 'agent_status', data: { profile, status: 'idle', jobId } })
  }
}

const LEGACY_SLOTS = new Set([
  'opus', 'fable', 'sonnet', 'haiku',
  'codex-frontier', 'codex-balanced', 'codex-high',
  'cursor-grok', 'cursor-composer', 'ollama', 'hermes',
])

function isLegacyModelSlot(value: string): boolean {
  return LEGACY_SLOTS.has(value)
}
