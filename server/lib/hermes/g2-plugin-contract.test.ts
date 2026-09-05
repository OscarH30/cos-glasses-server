import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = join(dirname(fileURLToPath(import.meta.url)), '../../../hermes-plugin/g2')

describe('g2 Hermes plugin contract', () => {
  it('imports only the ntfy-compatible gateway.platforms surface', () => {
    const adapter = readFileSync(join(root, 'adapter.py'), 'utf8')
    expect(adapter).toContain('from gateway.platforms.base import BasePlatformAdapter, MessageEvent, MessageType, SendResult')
    expect(adapter).toContain('from gateway.config import Platform, PlatformConfig')
  })

  it('registers platform g2 and the g2 approval transport', () => {
    const adapter = readFileSync(join(root, 'adapter.py'), 'utf8')
    expect(adapter).toContain('name="g2"')
    expect(adapter).toContain('register_approval_transport("g2"')
  })

  it('declares the loopback env contract', () => {
    const yaml = readFileSync(join(root, 'plugin.yaml'), 'utf8')
    expect(yaml).toContain('name: g2-platform')
    expect(yaml).toContain('G2_SERVER_URL')
    expect(yaml).toContain('G2_PLUGIN_TOKEN')
  })
})
