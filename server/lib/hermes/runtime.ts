import { HermesApprovals } from './approvals.js'
import { loadHermesConfig, type HermesConfig } from './config.js'
import { HermesInbox } from './inbox.js'
import { HermesInboundLedger } from './inbound-ledger.js'
import { HermesProfileRegistry } from './profiles.js'
import { HermesTurnWaiter } from './turn-waiter.js'

export interface HermesRuntime {
  config: HermesConfig
  ledger: HermesInboundLedger
  inbox: HermesInbox
  approvals: HermesApprovals
  profiles: HermesProfileRegistry
  turns: HermesTurnWaiter
}

let runtime: HermesRuntime | null = null

export function getHermesRuntime(): HermesRuntime {
  if (runtime) return runtime
  const config = loadHermesConfig()
  runtime = {
    config,
    ledger: new HermesInboundLedger(),
    inbox: new HermesInbox(),
    approvals: new HermesApprovals(),
    profiles: new HermesProfileRegistry(
      config.profiles.length > 0
        ? config.profiles.map(profile => ({ name: profile.name, label: profile.label }))
        : [{ name: config.defaultProfile, label: config.defaultProfile }],
    ),
    turns: new HermesTurnWaiter(),
  }
  return runtime
}

export function resetHermesRuntimeForTests(): void {
  runtime = null
}

export function hermesHealthSnapshot(): {
  defaultProfile: string
  apiServer: 'ok' | 'unconfigured'
  inbox: number
  pendingApprovals: number
  profiles: ReturnType<HermesProfileRegistry['list']>
} {
  const current = getHermesRuntime()
  return {
    defaultProfile: current.config.defaultProfile,
    apiServer: current.config.apiUrl && current.config.apiKey ? 'ok' : 'unconfigured',
    inbox: current.inbox.unreadCount(),
    pendingApprovals: current.approvals.pendingCount(),
    profiles: current.profiles.list(),
  }
}
