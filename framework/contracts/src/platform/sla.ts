// SLA timers as clients read them (GET /api/sla, the sla feature in @hykr/api).
// docs/decisions/B6B4.md.
import { z } from 'zod';
import { reserveRoutes } from '../catalog.js';

reserveRoutes('sla');

export const SlaStatus = z.enum(['running', 'met', 'breached', 'cancelled']);
export type SlaStatus = z.infer<typeof SlaStatus>;

/** One SLA clock on one record. */
export const SlaTimer = z.object({
  id: z.string(),
  /** The SLA's name, as its module declares it: 'orders.decision'. */
  sla: z.string(),
  resourceType: z.string(),
  resourceId: z.string(),
  /** The state it runs in. */
  state: z.string(),
  status: SlaStatus,
  /** 'business': only the business's open hours count. */
  hours: z.enum(['business', 'all']),
  startedAt: z.iso.datetime(),
  dueAt: z.iso.datetime(),
  /** When the record left the state (null while it is in it). */
  endedAt: z.iso.datetime().nullable(),
  breachedAt: z.iso.datetime().nullable(),
  /** Why the escalation's transition did not run, when it did not. */
  escalationError: z.string().nullable(),
});
export type SlaTimer = z.infer<typeof SlaTimer>;

/**
 * GET /api/sla: the business's timers in one status, on records the caller reads, earliest due
 * first. `open=true` keeps only the clocks whose record is still in the state (a breach still
 * late: what a Today view shows), `open=false` only the ended ones; without it, both.
 */
export const SlaQuery = z.object({
  status: SlaStatus.default('breached'),
  open: z
    .preprocess((v) => (v === 'true' ? true : v === 'false' ? false : v), z.boolean())
    .optional(),
  resourceType: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type SlaQuery = z.infer<typeof SlaQuery>;
/** What a client asks GET /api/sla for (each part optional: the server fills the defaults). */
export type SlaListInput = Partial<SlaQuery>;
