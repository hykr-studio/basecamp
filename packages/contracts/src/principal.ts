import { z } from 'zod';
export const Role = z.enum(['admin', 'ops', 'owner', 'operator', 'builder', 'agent']);
export const Principal = z.object({
  actor: z.object({ kind: z.enum(['user', 'agent']), id: z.string(), role: Role }),
  actingFor: z.object({ userId: z.string() }).optional(),
  runId: z.string().optional(),
  agentVersion: z.string().optional(),
  scopes: z.array(z.string()),
  /** Set when a person approved this parked operation; it is being replayed for them. */
  approvedBy: z.string().optional(),
});
export type Principal = z.infer<typeof Principal>;
