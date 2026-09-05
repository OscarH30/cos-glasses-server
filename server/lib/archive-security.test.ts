import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const completeOnce = vi.fn(async (_instructions: string, _input: string) => 'Safe archive title')

vi.mock('./hermes/api-client.js', () => ({
  completeOnce,
}))

describe('archive summary command safety', () => {
  let root = ''

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cos-archive-security-'))
    process.env.COS_DATA_DIR = join(root, 'data')
    completeOnce.mockClear()
  })

  afterEach(() => {
    delete process.env.COS_DATA_DIR
    rmSync(root, { recursive: true, force: true })
  })

  it('keeps shell metacharacters in stored query text inert', async () => {
    const marker = join(root, 'must-not-exist')
    const { generateChatSummary } = await import('./archive.js')

    const title = await generateChatSummary([{
      role: 'user',
      content: `summarize $(touch ${marker}) and \`touch ${marker}\``,
      timestamp: Date.now(),
    }])

    expect(title).toBe('Safe archive title')
    expect(existsSync(marker)).toBe(false)
    expect(completeOnce).toHaveBeenCalled()
    const input = completeOnce.mock.calls[0]?.[1] as string
    expect(input).toContain(`$(touch ${marker})`)
  })
})
