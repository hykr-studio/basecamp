import { z } from 'zod';

export const AuthorizeResult = z.object({
  decision: z.enum(['allow', 'deny', 'needs_approval']),
  rule: z.string(),
  reason: z.string(),
});
export type AuthorizeResult = z.infer<typeof AuthorizeResult>;
