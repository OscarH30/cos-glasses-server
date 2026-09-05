import { Router, type Request, type Response } from 'express'

const GONE = {
  error: 'gone',
  reason: 'hermes_cron',
  message: 'Morning brief and tasks are Hermes cron jobs now. See docs/ops-hermes.md and scripts/bootstrap-jobs.sh.',
}

function gone(_req: Request, res: Response): void {
  res.status(410).json(GONE)
}

export const goneMorningBriefRouter = Router()
goneMorningBriefRouter.use('/morning-brief', gone)

export const goneTasksRouter = Router()
goneTasksRouter.use('/tasks', gone)
goneTasksRouter.all('/domains', gone)
