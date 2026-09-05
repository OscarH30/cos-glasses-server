import express from 'express'
import type { Server } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { goneMorningBriefRouter, goneTasksRouter } from './hermes-gone.js'

let server: Server
let base = ''

beforeAll(async () => {
  const app = express()
  app.use('/api', goneMorningBriefRouter)
  app.use('/api', goneTasksRouter)
  server = await new Promise<Server>(resolve => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener))
  })
  const address = server.address()
  base = typeof address === 'object' && address ? `http://127.0.0.1:${address.port}` : ''
})

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()))
})

describe('retired Cos schedulers', () => {
  it.each(['/api/morning-brief', '/api/morning-brief/run', '/api/tasks', '/api/tasks/next', '/api/domains'])(
    'returns 410 for %s',
    async (path) => {
      const response = await fetch(`${base}${path}`)
      expect(response.status).toBe(410)
      expect(await response.json()).toMatchObject({ error: 'gone', reason: 'hermes_cron' })
    },
  )
})
