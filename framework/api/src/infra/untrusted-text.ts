// Text someone sends holds only what Postgres keeps (docs/decisions/V10.md). Its text and jsonb
// have no room for U+0000, and jsonb none for half of a UTF-16 surrogate pair: one that reached a
// query or a write was a 500 (22021, 22P05) on every entity list, summary and write, and on any
// feature's route. One check at the request's edge, before any pipe or handler reads it, refuses
// it as a 400 wherever it is: a route parameter, the query string (keys and values, as Express
// parsed it and as the raw URL holds it past the parser's 1000 keys) or the JSON or form body
// (keys and values, at any depth). The API's routes get it from a global guard; Better Auth's,
// which no Nest guard sees, from a hook in front of every endpoint (infra/auth.ts). Text decoded
// after the edge is its reader's to check, with the same rule: a list's custom filter JSON
// (`CustomFilter`, answered through `UntrustedTextPipe`), keyset cursors (`keysetOf`), the SLA
// cursor, an import's rows; an entity list cursor's values reach the list's class-22 backstop.
import { TEXT_FAULTS, type TextFault, unstorableTextAt } from '@hykr/contracts';
import {
  type ArgumentMetadata,
  BadRequestException,
  type CanActivate,
  type ExecutionContext,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ZodValidationException, ZodValidationPipe } from 'nestjs-zod';

const BYTES = 'untrusted-text:bytes';

/**
 * The route's body is a file's bytes, not text (a blob upload): a NUL in it is data. Its path
 * and query string are still checked.
 */
export const TakesBytes = () => SetMetadata(BYTES, true);

/** What a request holding text Postgres cannot keep is answered (400), with `where` it was. */
export const textRefusal = (rule: TextFault, where: string) => ({
  error: 'invalid' as const,
  rule,
  message: TEXT_FAULTS[rule],
  where,
});

/**
 * The raw query string's keys and values, decoded as `URLSearchParams` decodes them: Express's
 * parser keeps the first 1000 keys, and a page that reads the raw URL again (the OAuth pages)
 * sees them all.
 */
function rawQueryAt(url: string | undefined): { where: string; rule: TextFault } | null {
  const i = url ? url.indexOf('?') : -1;
  if (!url || i < 0) return null;
  for (const [key, value] of new URLSearchParams(url.slice(i + 1))) {
    const bad = unstorableTextAt({ [key]: value }, 'query');
    if (bad) return bad;
  }
  return null;
}

/** A global guard: text Postgres cannot keep anywhere in what the request sends is 400. */
@Injectable()
export class UntrustedTextGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== 'http') return true;
    const req = context.switchToHttp().getRequest<{
      params?: unknown;
      query?: unknown;
      body?: unknown;
      originalUrl?: string;
      url?: string;
    }>();
    const bytes = this.reflector.getAllAndOverride<boolean>(BYTES, [
      context.getHandler(),
      context.getClass(),
    ]);
    const bad =
      unstorableTextAt(req.params, 'path') ??
      unstorableTextAt(req.query, 'query') ??
      rawQueryAt(req.originalUrl ?? req.url) ??
      (bytes ? null : unstorableTextAt(req.body, 'body'));
    if (bad) throw new BadRequestException(textRefusal(bad.rule, bad.where));
    return true;
  }
}

const FAULTS: ReadonlySet<string> = new Set(Object.keys(TEXT_FAULTS));

/**
 * The API's validation pipe (`nestjs-zod`'s), answering a schema's text refusal (a custom
 * filter's decoded JSON) as the edge does: 400 `{ error: 'invalid', rule, where }`.
 */
@Injectable()
export class UntrustedTextPipe extends ZodValidationPipe {
  transform(value: unknown, metadata: ArgumentMetadata) {
    try {
      return super.transform(value, metadata);
    } catch (e) {
      if (!(e instanceof ZodValidationException)) throw e;
      const issues = (e.getZodError() as { issues?: unknown[] } | undefined)?.issues ?? [];
      for (const issue of issues as { path?: PropertyKey[]; params?: { rule?: unknown } }[]) {
        const rule = issue.params?.rule;
        if (typeof rule === 'string' && FAULTS.has(rule)) {
          const where = [metadata.type, ...(issue.path ?? []).map(String)].join('.');
          throw new BadRequestException(textRefusal(rule as TextFault, where));
        }
      }
      throw e;
    }
  }
}
