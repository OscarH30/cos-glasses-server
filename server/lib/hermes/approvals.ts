import { emitDisplay } from '../display-bus.js'

export type HermesApprovalChoice = 'once' | 'session' | 'always' | 'deny'

export interface HermesApprovalRequest {
  requestId: string
  digest: string
  command: string
  description: string
  choices: HermesApprovalChoice[]
  timeoutS: number
  origin?: string
  profile: string
  createdAt: string
  expiresAt: number
}

interface PendingApproval {
  request: HermesApprovalRequest
  waiters: Array<(choice: HermesApprovalChoice | null) => void>
  timer: ReturnType<typeof setTimeout>
}

const ALLOWED = new Set<HermesApprovalChoice>(['once', 'session', 'always', 'deny'])

export class HermesApprovals {
  private readonly pending = new Map<string, PendingApproval>()

  present(input: Omit<HermesApprovalRequest, 'createdAt' | 'expiresAt'>): HermesApprovalRequest {
    const existing = this.pending.get(input.requestId)
    if (existing) return existing.request
    const timeoutS = Math.max(1, Math.min(input.timeoutS || 60, 600))
    const request: HermesApprovalRequest = {
      ...input,
      choices: input.choices.filter(choice => ALLOWED.has(choice)),
      createdAt: new Date().toISOString(),
      expiresAt: Date.now() + timeoutS * 1000,
    }
    if (request.choices.length === 0) request.choices = ['once', 'deny']
    const entry: PendingApproval = {
      request,
      waiters: [],
      timer: setTimeout(() => this.resolve(request.requestId, null), timeoutS * 1000),
    }
    entry.timer.unref?.()
    this.pending.set(request.requestId, entry)
    emitDisplay({
      type: 'approval_required',
      data: {
        requestId: request.requestId,
        description: request.description,
        command: request.command,
        choices: request.choices,
        timeoutS,
        profile: request.profile,
      },
    })
    return request
  }

  wait(requestId: string): Promise<HermesApprovalChoice | null> {
    const entry = this.pending.get(requestId)
    if (!entry) return Promise.resolve(null)
    return new Promise(resolve => {
      entry.waiters.push(resolve)
    })
  }

  decide(requestId: string, choice: string): HermesApprovalChoice | null {
    const entry = this.pending.get(requestId)
    if (!entry) return null
    if (!ALLOWED.has(choice as HermesApprovalChoice)) return null
    if (!entry.request.choices.includes(choice as HermesApprovalChoice)) return null
    this.resolve(requestId, choice as HermesApprovalChoice)
    return choice as HermesApprovalChoice
  }

  get(requestId: string): HermesApprovalRequest | null {
    return this.pending.get(requestId)?.request ?? null
  }

  pendingCount(): number {
    return this.pending.size
  }

  private resolve(requestId: string, choice: HermesApprovalChoice | null): void {
    const entry = this.pending.get(requestId)
    if (!entry) return
    clearTimeout(entry.timer)
    this.pending.delete(requestId)
    emitDisplay({
      type: 'approval_resolved',
      data: { requestId, choice: choice ?? 'deny', profile: entry.request.profile },
    })
    for (const waiter of entry.waiters) waiter(choice)
  }
}
