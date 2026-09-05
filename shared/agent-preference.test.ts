import { describe, expect, it } from 'vitest'
import { effortPrefix, normalizeAgentPreference } from './agent-preference.js'

describe('normalizeAgentPreference', () => {
  it('keeps an explicit Hermes profile', () => {
    expect(normalizeAgentPreference({ profile: 'eve', effort: 'high' })).toEqual({
      profile: 'eve',
      effort: 'high',
    })
  })

  it('maps Cos model slots to the default profile for one release', () => {
    expect(normalizeAgentPreference('sonnet', 'eve')).toEqual({ profile: 'eve' })
    expect(normalizeAgentPreference('codex-frontier', 'eve')).toEqual({ profile: 'eve' })
  })

  it('treats an unknown string as a profile name', () => {
    expect(normalizeAgentPreference('work', 'eve')).toEqual({ profile: 'work' })
  })

  it('prefixes effort only when set', () => {
    expect(effortPrefix({ profile: 'eve' })).toBe('')
    expect(effortPrefix({ profile: 'eve', effort: 'max' })).toBe('/model --once max\n')
  })
})
