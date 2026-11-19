import { BadRequestException } from '@nestjs/common';
import type { z } from 'zod';

/** A body or query, parsed, or 400 with what is wrong. */
export function parsed<T>(schema: z.ZodType<T>, value: unknown, error = 'invalid_request'): T {
  const r = schema.safeParse(value ?? {});
  if (!r.success)
    throw new BadRequestException({
      error,
      problems: r.error.issues.map((i) => `${i.path.join('.') || '(body)'}: ${i.message}`),
    });
  return r.data;
}
