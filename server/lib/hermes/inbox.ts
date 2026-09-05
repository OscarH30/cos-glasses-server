import { randomUUID } from 'node:crypto'
import { emitDisplay } from '../display-bus.js'

export type HermesInboxKind = 'reply' | 'cron' | 'notice' | 'progress'

export interface HermesInboxItem {
  id: string
  profile: string
  kind: HermesInboxKind
  text: string
  correlationId?: string
  replyTo?: string
  createdAt: string
  read: boolean
}

const MAX_ITEMS = 200

export class HermesInbox {
  private readonly items: HermesInboxItem[] = []

  deliver(input: {
    profile: string
    kind: HermesInboxKind
    text: string
    correlationId?: string
    replyTo?: string
  }): HermesInboxItem {
    const item: HermesInboxItem = {
      id: `inb_${randomUUID()}`,
      profile: input.profile,
      kind: input.kind,
      text: input.text,
      ...(input.correlationId ? { correlationId: input.correlationId } : {}),
      ...(input.replyTo ? { replyTo: input.replyTo } : {}),
      createdAt: new Date().toISOString(),
      read: false,
    }
    this.items.push(item)
    if (this.items.length > MAX_ITEMS) this.items.shift()
    if (input.kind !== 'progress') {
      emitDisplay({
        type: 'hermes_message',
        data: {
          inboxId: item.id,
          profile: item.profile,
          kind: item.kind,
          text: item.text,
          ...(item.correlationId ? { correlationId: item.correlationId } : {}),
        },
      })
    } else {
      emitDisplay({
        type: 'tool_status',
        data: { message: item.text, profile: item.profile },
      })
    }
    return item
  }

  list(since?: string): HermesInboxItem[] {
    if (!since) return [...this.items]
    const idx = this.items.findIndex(item => item.id === since)
    return idx >= 0 ? this.items.slice(idx + 1) : [...this.items]
  }

  markRead(id: string): HermesInboxItem | null {
    const item = this.items.find(entry => entry.id === id)
    if (!item) return null
    item.read = true
    return item
  }

  unreadCount(): number {
    return this.items.filter(item => !item.read).length
  }
}
