import { randomBytes } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { appendPrivateEnvBlock, UnsafeUserConfigPathError } from '../secure-user-config.js'

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1'])

export interface HermesProfileConfig {
  name: string
  label: string
  url: string
  key?: string
}

export interface HermesConfig {
  pluginToken: string
  pluginTokenPersisted: boolean
  apiUrl: string | null
  apiKey: string | null
  defaultProfile: string
  sessionKeyPrefix: string
  profiles: HermesProfileConfig[]
  turnTimeoutMs: number
}

let cached: HermesConfig | null = null

function env(name: string): string {
  return (process.env[name] ?? '').trim()
}

function parseProfiles(): HermesProfileConfig[] {
  const raw = env('HERMES_PROFILES')
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as unknown
      if (Array.isArray(parsed)) {
        return parsed.flatMap(entry => {
          if (!entry || typeof entry !== 'object') return []
          const row = entry as Record<string, unknown>
          const name = typeof row.name === 'string' ? row.name.trim() : ''
          const url = typeof row.url === 'string' ? row.url.trim() : ''
          if (!name || !url) return []
          return [{
            name,
            label: typeof row.label === 'string' && row.label.trim() ? row.label.trim() : name,
            url: url.replace(/\/$/, ''),
            ...(typeof row.key === 'string' && row.key.trim() ? { key: row.key.trim() } : {}),
          }]
        })
      }
    } catch {
      /* fall through to single-profile default */
    }
  }
  const url = env('HERMES_API_URL')
  if (!url) return []
  const name = env('HERMES_DEFAULT_PROFILE') || 'eve'
  return [{
    name,
    label: name,
    url: url.replace(/\/$/, ''),
    ...(env('HERMES_API_KEY') ? { key: env('HERMES_API_KEY') } : {}),
  }]
}

function mintPluginToken(): { token: string; persisted: boolean } {
  const existing = env('HERMES_PLUGIN_TOKEN')
  if (existing) return { token: existing, persisted: false }
  const token = `g2_${randomBytes(32).toString('base64url')}`
  process.env.HERMES_PLUGIN_TOKEN = token
  if (process.env.VITEST || process.env.COS_MANAGED === '1') {
    return { token, persisted: false }
  }
  try {
    appendPrivateEnvBlock(
      join(homedir(), '.cos-glasses', '.env'),
      `# auto-generated Hermes plugin token (loopback /hermes/* only)\nHERMES_PLUGIN_TOKEN=${token}\n`,
    )
    return { token, persisted: true }
  } catch (error) {
    if (error instanceof UnsafeUserConfigPathError) throw error
    return { token, persisted: false }
  }
}

export function loadHermesConfig(): HermesConfig {
  if (cached) return cached
  const minted = mintPluginToken()
  const profiles = parseProfiles()
  cached = {
    pluginToken: minted.token,
    pluginTokenPersisted: minted.persisted,
    apiUrl: env('HERMES_API_URL').replace(/\/$/, '') || null,
    apiKey: env('HERMES_API_KEY') || null,
    defaultProfile: env('HERMES_DEFAULT_PROFILE') || profiles[0]?.name || 'eve',
    sessionKeyPrefix: env('HERMES_SESSION_KEY_PREFIX') || 'agent:main:g2',
    profiles,
    turnTimeoutMs: Math.max(10_000, Number(env('HERMES_TURN_TIMEOUT_MS') || 600_000) || 600_000),
  }
  return cached
}

export function resetHermesConfigForTests(): void {
  cached = null
}

export function isLoopbackAddress(value: string): boolean {
  const clean = value.replace(/^::ffff:/, '')
  return clean === '127.0.0.1' || clean === '::1' || clean.startsWith('127.')
}

export function assertLoopbackApiUrl(url: string): void {
  if (process.env.HERMES_ALLOW_REMOTE === '1') return
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error(`HERMES_API_URL is not a valid URL: ${url}`)
  }
  if (!LOOPBACK_HOSTS.has(parsed.hostname) && parsed.hostname !== '127.0.0.1') {
    throw new Error(`HERMES_API_URL must be loopback (got ${parsed.hostname}). Set HERMES_ALLOW_REMOTE=1 to override.`)
  }
}
