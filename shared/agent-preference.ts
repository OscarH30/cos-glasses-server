import { normalizeModelPreference } from './model-preference.js'

export type HermesEffort = 'high' | 'xhigh' | 'max'

export interface AgentPreference {
  profile: string
  effort?: HermesEffort
}

const EFFORTS = new Set<HermesEffort>(['high', 'xhigh', 'max'])

export function normalizeAgentPreference(
  value: unknown,
  fallbackProfile = process.env.HERMES_DEFAULT_PROFILE?.trim() || 'eve',
): AgentPreference {
  if (value && typeof value === 'object') {
    const row = value as { profile?: unknown; effort?: unknown }
    const profile = typeof row.profile === 'string' && row.profile.trim()
      ? row.profile.trim()
      : fallbackProfile
    const effort = typeof row.effort === 'string' && EFFORTS.has(row.effort as HermesEffort)
      ? row.effort as HermesEffort
      : undefined
    return effort ? { profile, effort } : { profile }
  }
  if (typeof value === 'string' && value.trim()) {
    const slot = normalizeModelPreference(value)
    if (!slot || slot === 'hermes') {
      return { profile: slot === 'hermes' ? fallbackProfile : value.trim() }
    }
    return { profile: fallbackProfile }
  }
  return { profile: fallbackProfile }
}

export function effortPrefix(preference: AgentPreference): string {
  return preference.effort ? `/model --once ${preference.effort}\n` : ''
}
