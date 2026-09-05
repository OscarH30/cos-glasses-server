export interface HermesProfileConnection {
  name: string
  label: string
  connected: boolean
  lastSeen: string | null
  subscribers: number
}

export class HermesProfileRegistry {
  private readonly connections = new Map<string, { lastSeen: number; subscribers: number; label: string }>()

  constructor(private readonly known: Array<{ name: string; label: string }>) {
    for (const profile of known) {
      this.connections.set(profile.name, { lastSeen: 0, subscribers: 0, label: profile.label })
    }
  }

  ensure(name: string, label = name): void {
    if (!this.connections.has(name)) {
      this.connections.set(name, { lastSeen: 0, subscribers: 0, label })
    }
  }

  subscribe(name: string): void {
    this.ensure(name)
    const row = this.connections.get(name)!
    row.subscribers += 1
    row.lastSeen = Date.now()
  }

  unsubscribe(name: string): void {
    const row = this.connections.get(name)
    if (!row) return
    row.subscribers = Math.max(0, row.subscribers - 1)
    row.lastSeen = Date.now()
  }

  heartbeat(name: string): void {
    this.ensure(name)
    this.connections.get(name)!.lastSeen = Date.now()
  }

  list(): HermesProfileConnection[] {
    const now = Date.now()
    return [...this.connections.entries()].map(([name, row]) => ({
      name,
      label: row.label,
      connected: row.subscribers > 0 && now - row.lastSeen < 90_000,
      lastSeen: row.lastSeen ? new Date(row.lastSeen).toISOString() : null,
      subscribers: row.subscribers,
    }))
  }

  connectedNames(): string[] {
    return this.list().filter(row => row.connected).map(row => row.name)
  }
}
