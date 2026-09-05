import { carriesBoundTo } from './agent-session-binding-store.js'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { acquireModelSessionRunLock } from './model-router.js'
import { runHermesPlatformTurn } from './hermes/turn-runner.js'
import { resolveQueryAttachments } from './query-attachments.js'
import { getMediaStore } from './media-store.js'
import { dataPath } from './data-dir.js'
import { currentMessageEra, LEGACY_MESSAGE_ERA } from './message-era.js'
import { durableQueryJobsEnabled } from './query-job-feature.js'
import { QueryJobCoordinator, type QueryJobRunner } from './query-job-coordinator.js'
import { QueryJobStore } from './query-job-store.js'
import {
  normalizeModelPreference,
  type ModelPreference,
} from '../../shared/model-preference.js'
import { mergeMediaAttachmentRefs } from '../../shared/media-attachment.js'
import { attachmentHistoryPrefix, defaultAttachmentRequest } from '../../shared/media-attachment.js'
import {
  findExchangesByJobIdentity,
  flushConversationToDisk,
  reconcileExchangeByJobIdentity,
  removeExchangesByJobIdentity,
} from './conversation.js'
import {
  isTerminalQueryJobStatus,
  type QueryJobRequest,
  type QueryJobSnapshot,
} from './query-job-types.js'
import { acquireMaintenanceWork } from './maintenance-lifecycle.js'
import { registerMessageReservationSource } from './message-reservations.js'

export class QueryJobAdmissionPreparationError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message)
    this.name = 'QueryJobAdmissionPreparationError'
  }
}

/** Resolve image bytes/ids before returning 202. The journal receives only
 * validated refs and ids; base64 bytes and provider-local paths are dropped by
 * the strict QueryJobRequest parser before persistence. Once a reset era
 * exists, reject pre-era clients before they stamp five-digit numbers into
 * the fresh namespace. */
export async function preparePublicDurableQueryAdmission(raw: unknown): Promise<unknown> {
  if (!raw || typeof raw !== 'object') return raw
  const input = raw as Record<string, unknown>

  // Plan 4.2: an attached turn must NEVER silently degrade into an ordinary COS
  // turn. The binding lives in the route path rather than the body, so a
  // re-admission through this generic route would otherwise carry no attachment
  // fields at all and there would be nothing here to reject — the turn would just
  // quietly run against COS's own conversation instead of the user's desktop
  // thread, and look like it worked.
  //
  // `carriesBoundTo` is the marker that makes such a request recognisable. It has
  // existed, tested, with no caller since it was written.
  //
  // Defensive today: attached turns are not journal-backed until Phase 2, so
  // nothing currently produces a request carrying this marker. It is wired now
  // because the moment Phase 2 does, the absence of this check becomes a silent
  // downgrade rather than a loud refusal.
  if (carriesBoundTo(input)) {
    throw new QueryJobAdmissionPreparationError(
      409,
      'attached_turn_on_generic_route',
      'That turn belongs to a thread on your Mac and cannot run as an ordinary COS turn.',
    )
  }

  const activeEra = currentMessageEra()
  if (activeEra !== LEGACY_MESSAGE_ERA && input.messageEra !== activeEra) {
    throw new QueryJobAdmissionPreparationError(
      409,
      'message_era_mismatch',
      'Reopen or update COS Glasses. Your cards stay; the next message is #1.',
    )
  }
  try {
    const resolved = await resolveQueryAttachments(input)
    const { dispatch: _strippedDispatch, origin: rawOrigin, ...rest } = input
    const origin = (rawOrigin && typeof rawOrigin === 'object' && (rawOrigin as { kind?: string }).kind === 'task')
      ? undefined
      : rawOrigin
    if (_strippedDispatch !== undefined || origin !== rawOrigin) queryJobStore.noteOriginStripped()
    return {
      ...rest,
      ...(origin !== undefined ? { origin } : {}),
      messageEra: activeEra,
      attachmentIds: resolved.ids,
      attachmentRefs: resolved.refs,
    }
  } catch (error: any) {
    if (Number.isInteger(error?.status) && typeof error?.code === 'string') {
      throw new QueryJobAdmissionPreparationError(error.status, error.code, error.message)
    }
    throw error
  }
}

function providerFor(_model: ModelPreference | undefined): 'hermes' {
  return 'hermes'
}

/** The origin label as it travels on the display bus and the message views:
 * FLATTENED (`origin: 'routine', originId: 'morning-brief'`) so every client
 * parses one shape, and identical on `start`, `done` and `error`. Spread LAST
 * into each event so no provider metadata key can overwrite it. */
/** Project the authoritative terminal journal into the derived conversation
 * cache. Journaled request/response text always wins over bridge-written
 * partial rows; validated media refs may be merged because output media can
 * finish immediately before a crash. Exact provenance collapses duplicates. */
export async function projectPublicConversationTerminal(
  job: QueryJobSnapshot,
  request: QueryJobRequest,
): Promise<void> {
  if (!isTerminalQueryJobStatus(job.status)) return
  const identity = { clientJobId: request.clientJobId, generation: request.generation }
  if (job.status !== 'completed') {
    removeExchangesByJobIdentity(request.sessionId, identity)
    flushConversationToDisk()
    return
  }

  const existing = findExchangesByJobIdentity(request.sessionId, identity)
  const existingAssistant = existing.find(exchange => exchange.role === 'assistant')
  const attachmentPrefix = attachmentHistoryPrefix(request.attachmentRefs)
  const defaultRequest = defaultAttachmentRequest(request.attachmentRefs)
  const userContent = attachmentPrefix
    ? `${attachmentPrefix} ${request.query || defaultRequest}`
    : request.query
  const requestIds = new Set(request.attachmentRefs.map(ref => ref.id))
  const outputAttachments = job.attachments.filter(ref => !requestIds.has(ref.id))
  const existingOutputAttachments = existingAssistant?.attachments?.filter(ref => !requestIds.has(ref.id))

  reconcileExchangeByJobIdentity(
    request.sessionId,
    identity,
    'user',
    userContent,
    request.globalMsgNum,
    request.attachmentRefs,
    request.messageEra,
    normalizeModelPreference(request.model),
    request.origin,
  )
  reconcileExchangeByJobIdentity(
    request.sessionId,
    identity,
    'assistant',
    job.response ?? job.partialText,
    request.globalMsgNum,
    mergeMediaAttachmentRefs(outputAttachments, existingOutputAttachments),
    request.messageEra,
    normalizeModelPreference(request.model),
    request.origin,
  )
  flushConversationToDisk()
}

const runner: QueryJobRunner = async (context) => {
  const { request, callbacks } = context
  const resolvedAttachments = await resolveQueryAttachments({
    attachmentIds: request.attachmentIds,
    clientQueueItemId: request.clientQueueItemId,
    sessionId: request.sessionId,
  })
  await runHermesPlatformTurn({
    ...context,
    callbacks: {
      ...callbacks,
      onDone: async (completion) => {
        const attachments = mergeMediaAttachmentRefs(
          resolvedAttachments.refs,
          Array.isArray(completion.attachments) ? completion.attachments as never : undefined,
        )
        const attachmentLease = resolvedAttachments.ids.length > 0
          ? acquireMaintenanceWork('query_attachment_write', { allowDuringDrain: true })
          : undefined
        try {
          const terminalOwned = await callbacks.onDone({
            ...completion,
            attachments,
            provider: 'hermes',
            resolvedModel: completion.resolvedModel ?? providerFor(normalizeModelPreference(request.model)),
          })
          if (!terminalOwned) return false
          if (resolvedAttachments.ids.length > 0) {
            await getMediaStore().associate(resolvedAttachments.ids, {
              sessionId: request.sessionId,
              ...(request.globalMsgNum ? { globalMsgNum: request.globalMsgNum } : {}),
              messageEra: request.messageEra,
            }).catch(error => console.error('[query-jobs] attachment association failed:', error))
          }
          return true
        } finally {
          attachmentLease?.release()
        }
      },
    },
  })
}

const configuredRoot = process.env.COS_QUERY_JOB_DIR?.trim()
const queryJobRoot = configuredRoot ? resolve(configuredRoot) : dataPath('query-jobs')

export const queryJobStore = new QueryJobStore({
  root: queryJobRoot,
  bootId: randomUUID(),
})

export const queryJobCoordinator = new QueryJobCoordinator(queryJobStore, runner, {
  projectTerminal: projectPublicConversationTerminal,
  acquireSessionLock: acquireModelSessionRunLock,
  acquireMaintenanceWork: () => acquireMaintenanceWork('durable_query', { phase: 'queued' }),
})

// A job's number is a live reservation from admission until its terminal
// projection; the counter must see it or the phone mints it again.
registerMessageReservationSource(() => queryJobCoordinator.liveMessageReservations().map(item => ({
  globalMsgNum: item.globalMsgNum,
  ...(item.messageEra ? { messageEra: item.messageEra } : {}),
  owner: `job:${item.jobId}`,
})))

export function initQueryJobRuntime() {
  if (!durableQueryJobsEnabled()) return Promise.resolve(queryJobCoordinator.getHealth())
  return queryJobCoordinator.init()
}

export function shutdownQueryJobRuntime(reason = 'server_shutdown') {
  return queryJobCoordinator.shutdown(reason)
}

export function getQueryJobRuntimeHealth() {
  return queryJobCoordinator.getHealth()
}
