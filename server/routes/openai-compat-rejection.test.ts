import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

describe('OpenAI-compatible Hermes passthrough', () => {
  it('registers disconnect abort before the Hermes call', () => {
    const source = readFileSync(new URL('./openai-compat.ts', import.meta.url), 'utf8')
    const abortRegistration = source.indexOf("res.once('close'")
    const firstProviderStart = source.indexOf('hermesChatCompletions', abortRegistration)
    expect(abortRegistration).toBeGreaterThan(0)
    expect(firstProviderStart).toBeGreaterThan(abortRegistration)
    expect(source).toContain("providerAbort.abort(new Error('G2 client disconnected'))")
    expect(source).toContain('providerAbort.signal')
  })

  it('clears inflight state on both stream and non-stream failures', () => {
    const source = readFileSync(new URL('./openai-compat.ts', import.meta.url), 'utf8')
    expect(source.match(/inflightQueries\.delete\(dedupKey\)/g)?.length).toBeGreaterThanOrEqual(2)
  })
})
