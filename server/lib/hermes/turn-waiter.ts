export interface HermesTurnResult {
  text: string
  kind: 'reply' | 'cron' | 'notice'
}

interface PendingTurn {
  resolve: (result: HermesTurnResult) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export class HermesTurnWaiter {
  private readonly pending = new Map<string, PendingTurn>()

  wait(correlationId: string, timeoutMs: number): Promise<HermesTurnResult> {
    const existing = this.pending.get(correlationId)
    if (existing) {
      return new Promise((resolve, reject) => {
        const prevResolve = existing.resolve
        const prevReject = existing.reject
        existing.resolve = result => { prevResolve(result); resolve(result) }
        existing.reject = error => { prevReject(error); reject(error) }
      })
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(correlationId)
        reject(new Error('Eve did not answer; check the Hermes gateway.'))
      }, timeoutMs)
      timer.unref?.()
      this.pending.set(correlationId, { resolve, reject, timer })
    })
  }

  complete(correlationId: string, result: HermesTurnResult): boolean {
    const pending = this.pending.get(correlationId)
    if (!pending) return false
    clearTimeout(pending.timer)
    this.pending.delete(correlationId)
    pending.resolve(result)
    return true
  }

  fail(correlationId: string, error: Error): boolean {
    const pending = this.pending.get(correlationId)
    if (!pending) return false
    clearTimeout(pending.timer)
    this.pending.delete(correlationId)
    pending.reject(error)
    return true
  }

  pendingCount(): number {
    return this.pending.size
  }
}
