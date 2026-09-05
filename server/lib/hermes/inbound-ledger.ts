import { EventEmitter } from 'node:events'

export type HermesInboundKind = 'message' | 'stop' | 'keepalive'

export interface HermesInboundEvent {
  id: number
  profile: string
  kind: HermesInboundKind
  at: string
  payload: Record<string, unknown>
}

const MAX_EVENTS = 500

export class HermesInboundLedger {
  private readonly bus = new EventEmitter()
  private nextId = 1
  private readonly events: HermesInboundEvent[] = []

  append(profile: string, kind: HermesInboundKind, payload: Record<string, unknown>): HermesInboundEvent {
    const event: HermesInboundEvent = {
      id: this.nextId++,
      profile,
      kind,
      at: new Date().toISOString(),
      payload,
    }
    this.events.push(event)
    if (this.events.length > MAX_EVENTS) this.events.shift()
    this.bus.emit('event', event)
    return event
  }

  replay(profile: string, afterId: number): HermesInboundEvent[] {
    return this.events.filter(event => event.profile === profile && event.id > afterId)
  }

  onEvent(listener: (event: HermesInboundEvent) => void): () => void {
    this.bus.on('event', listener)
    return () => { this.bus.off('event', listener) }
  }

  latestId(profile: string): number {
    for (let i = this.events.length - 1; i >= 0; i--) {
      if (this.events[i]!.profile === profile) return this.events[i]!.id
    }
    return 0
  }
}
