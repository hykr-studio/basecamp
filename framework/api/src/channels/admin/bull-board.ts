import { createBullBoard } from '@bull-board/api';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { ExpressAdapter } from '@bull-board/express';
import { membershipOf } from '@hykr/db';
import { getQueueToken } from '@nestjs/bullmq';
import type { INestApplication } from '@nestjs/common';
import { fromNodeHeaders } from 'better-auth/node';
import type { Queue } from 'bullmq';
import type { NextFunction, Request, Response } from 'express';
import { queues } from '../../hooks.js';
import { auth } from '../../infra/auth.js';
import { sharedDb } from '../../infra/db.js';

const PATH = '/admin/queues';

/**
 * Bull Board at /admin/queues: every queue's jobs, retries and failures. A development tool:
 * never mounted in production, and only for a signed-in owner or admin. (A plain Express
 * router, so it checks the session itself; Nest's guards do not reach it.)
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
  const onlyAdmins = async (req: Request, res: Response, next: NextFunction) => {
    const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
    const member = session ? await membershipOf(sharedDb.db, session.user.id) : undefined;
    if (!member?.roles.some((r) => r === 'owner' || r === 'admin')) {
      res.status(session ? 403 : 401).send('Sign in to the app as an owner or admin first.');
      return;
    }
    next();
  };
  app.use(PATH, onlyAdmins, adapter.getRouter());
}
