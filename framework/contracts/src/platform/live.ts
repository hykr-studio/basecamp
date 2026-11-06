/**
 * Live updates (the framework's live feature): GET /api/live streams what changed, as server-sent
 * events, to the signed-in person. Each event names a record the person may read now, by id
 * only; the client loads it again through the API.
 */
import { z } from 'zod';
import { reserveRoutes } from '../catalog.js';

// /api/live: the live feature's stream.
reserveRoutes('live');

/** One `change` event on the stream: what happened to which record. Never its fields. */
export const LiveEvent = z.object({
  /** The event's name: 'task.updated', 'approval.requested'. */
  name: z.string(),
  /** The record's type, as audited: 'task', 'approval'. */
  type: z.string(),
  /** The record's id. */
  id: z.string(),
});
export type LiveEvent = z.infer<typeof LiveEvent>;
