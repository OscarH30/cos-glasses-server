import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '../../..')

function read(rel: string): string {
  return readFileSync(resolve(root, rel), 'utf8')
}

describe('VPS remote extras (no fork deploy)', () => {
  it('ships a two-line Eve notification skill', () => {
    const skill = read('hermes-plugin/skills/g2-notify/SKILL.md')
    expect(skill).toContain('[SILENT]')
    expect(skill).toMatch(/two short lines/i)
    expect(skill).toContain('You are Eve')
    expect(skill).not.toMatch(/You are COS/i)
  })

  it('binds ntfy to a Tailscale IPv4 only', () => {
    const script = read('scripts/install-ntfy-tailscale.sh')
    expect(script).toContain('listen-http: "${LISTEN_IP}:${PORT}"')
    expect(script).toContain('refusing to bind ntfy on a public wildcard')
    expect(script).toContain('is_tailscale_ipv4')
    expect(script).not.toMatch(/listen-http: ":/)
    expect(script).toContain('never prints')
  })

  it('defaults the morning brief to ntfy until g2 cutover', () => {
    const script = read('scripts/bootstrap-jobs.sh')
    expect(script).toContain('DELIVER="${2:-ntfy}"')
    expect(script).toContain('Do not use it on the live VPS until Oscar says go')
  })
})
