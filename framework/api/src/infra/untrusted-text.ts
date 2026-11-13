// Text someone sends never holds U+0000 (docs/decisions/V10.md). Postgres's text and jsonb have
// no room for it: a NUL that reached a query or a write was a 500 (22021, 22P05) on every entity
// list, summary and write, and on any feature's route. One check at the request's edge, before
// any pipe or handler reads it, refuses it as a 400 wherever it is: a route parameter, the query
// string (keys and values) or the JSON or form body (keys and values, at any depth). The API's
// routes get it from a global guard; Better Auth's, which no Nest guard sees, from a hook in
// front of every endpoint (infra/auth.ts). Text decoded later (a base64 cursor) is its reader's
// to check: keyset cursors go through `keysetOf`, entity list cursors through the list's
// class-22 backstop (`listQuery`).
import {
  BadRequestException,
  type CanActivate,
  type ExecutionContext,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';

const NUL = '\u0000';
const BYTES = 'untrusted-text:bytes';

/**
 * The route's body is a file's bytes, not text (a blob upload): a NUL in it is data. Its path
 * and query string are still checked.
 */
export const TakesBytes = () => SetMetadata(BYTES, true);

/** Plain data as a parser leaves it: arrays and plain objects; never a Buffer or a class. */
const plain = (v: object) => {
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
};

/**
 * Where the first NUL is in a parsed value (`body.lines[2].title`, a key or a string), or null.
 * Walks with its own stack, so a deeply nested body cannot overflow the call stack.
 */
export function nulAt(value: unknown, root: string): string | null {
  const stack: [unknown, string][] = [[value, root]];
  while (stack.length) {
    const [v, at] = stack.pop() as [unknown, string];
    if (typeof v === 'string') {
      if (v.includes(NUL)) return at;
    } else if (Array.isArray(v)) {
      for (let i = v.length - 1; i >= 0; i--) stack.push([v[i], `${at}[${i}]`]);
    } else if (v !== null && typeof v === 'object' && plain(v)) {
      for (const key of Object.keys(v)) {
        const named = `${at}.${key.replaceAll(NUL, '\\u0000')}`;
        if (key.includes(NUL)) return named;
        stack.push([(v as Record<string, unknown>)[key], named]);
      }
    }
  }
  return null;
}

/** What a request holding a NUL is answered (400), with `where` it was. */
export const NUL_REFUSAL = {
  error: 'invalid',
  rule: 'nul_character',
  message: 'Text may not hold the NUL character (U+0000)',
} as const;

/** A global guard: a NUL anywhere in what the request sends is 400 `nul_character`. */
@Injectable()
export class UntrustedTextGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== 'http') return true;
    const req = context.switchToHttp().getRequest<{
      params?: unknown;
      query?: unknown;
      body?: unknown;
    }>();
    const bytes = this.reflector.getAllAndOverride<boolean>(BYTES, [
      context.getHandler(),
      context.getClass(),
    ]);
    const where =
      nulAt(req.params, 'path') ??
      nulAt(req.query, 'query') ??
      (bytes ? null : nulAt(req.body, 'body'));
    if (where) throw new BadRequestException({ ...NUL_REFUSAL, where });
    return true;
  }
}
