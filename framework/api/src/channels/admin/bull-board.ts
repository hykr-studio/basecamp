import { createBullBoard } from '@bull-board/api';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { ExpressAdapter } from '@bull-board/express';
import { PlatformCapabilities } from '@hykr/contracts';
import { getQueueToken } from '@nestjs/bullmq';
import type { INestApplication } from '@nestjs/common';
import { fromNodeHeaders } from 'better-auth/node';
import type { Queue } from 'bullmq';
import type { NextFunction, Request, Response } from 'express';
import { operatorOf } from '../../features/platform/operators.js';
import { queues } from '../../hooks.js';
import { getAuth } from '../../infra/auth.js';
import { sharedDb } from '../../infra/db.js';

const PATH = '/admin/queues';

/**
 * Who may open Bull Board: a signed-in platform operator holding `platform.queues`. No session
 * 401; anyone else 403.
 */
export async function onlyOperators(req: Request, res: Response, next: NextFunction) {
  const session = await getAuth().api.getSession({ headers: fromNodeHeaders(req.headers) });
  const operator = session ? await operatorOf(sharedDb.db, session.user.id) : undefined;
  if (!operator?.capabilities.includes(PlatformCapabilities.queues.name)) {
    res
      .status(session ? 403 : 401)
      .send('Sign in to the app as a platform operator who may open the job queues first.');
    return;
  }
  next();
}

/**
 * Bull Board at /admin/queues: every queue's jobs, retries and failures, of every business. A
 * development tool: never mounted in production, and only for a platform operator holding
 * `platform.queues` (B19), never for a business's people. (A plain Express router, so it checks
 * the session itself; Nest's guards do not reach it.)
 */
export function mountBullBoard(app: INestApplication) {
  if (process.env.NODE_ENV === 'production') return;
  const adapter = new ExpressAdapter();
  adapter.setBasePath(PATH);
  createBullBoard({
    // Every registered queue: the channel's, the features' and the application's.
    queues: queues
      .all()
      .map((q) => new BullMQAdapter(app.get<Queue>(getQueueToken(q.name), { strict: false }))),
    serverAdapter: adapter,
  });
  app.use(PATH, onlyOperators, adapter.getRouter());
}
