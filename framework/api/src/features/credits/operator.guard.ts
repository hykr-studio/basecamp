import { createHash, timingSafeEqual } from 'node:crypto';
import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';

/**
 * The platform operator's key (OPERATOR_API_KEY), read when used so a test can set it. Until
 * B19's operators, holding it is what makes a caller the operator.
 */
const operatorKey = () => process.env.OPERATOR_API_KEY ?? '';

/** A key that is set must be strong and its own: never an agent's. Checked at startup. */
export function checkOperatorKey(env: Readonly<Record<string, string | undefined>> = process.env) {
  const key = env.OPERATOR_API_KEY ?? '';
  if (!key) return;
  if (key.length < 32)
    throw new Error('OPERATOR_API_KEY must be at least 32 characters (openssl rand -hex 32)');
  if (key === env.AGENT_API_KEY || key === env.VOICE_AGENT_KEY)
    throw new Error('OPERATOR_API_KEY must differ from AGENT_API_KEY and VOICE_AGENT_KEY');
}

const digest = (s: string) => createHash('sha256').update(s).digest();

/**
 * The operator's routes: `x-operator-key` must be the deployment's key. Without one configured,
 * the routes are not there (404); a missing or wrong key is 401.
 */
@Injectable()
export class OperatorGuard implements CanActivate {
  canActivate(context: ExecutionContext) {
    const key = operatorKey();
    if (!key) throw new NotFoundException();
    const sent = context.switchToHttp().getRequest<Request>().header('x-operator-key') ?? '';
    if (!timingSafeEqual(digest(sent), digest(key)))
      throw new UnauthorizedException({ error: 'operator_key', reason: 'Send the operator key' });
    return true;
  }
}
