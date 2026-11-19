// A member as a principal, for work done for them in the background: reading a record as they
// may see it (their calendar, their feed, an invite they asked for), or a module's subscriber
// writing as the person who changed something in their own calendar.
import type { Channel, Principal, WriteResult } from '@hykr/contracts';
import { PrincipalResolver, runWrite, type WriteOp } from '@hykr/core';
import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { EventBus } from '@nestjs/cqrs';
import type { ServerContext } from '../../hooks.js';

type Get = ServerContext['get'];

/**
 * The person in this business, with their roles and capabilities as of now, or null when they
 * are not a member there any more.
 */
export async function memberPrincipal(
  get: Get,
  a: { userId: string; tenantId: string; channel?: Channel },
): Promise<Principal | null> {
  const channel = a.channel ?? 'background';
  try {
    const standing = await get(PrincipalResolver).forUser(a.userId, {
      tenantId: a.tenantId,
      channel,
    });
    if (standing.tenantId !== a.tenantId) return null;
    return { actor: { kind: 'user', id: a.userId }, ...standing, scopes: [], channel };
  } catch (e) {
    if (e instanceof ForbiddenException || e instanceof UnauthorizedException) return null;
    throw e;
  }
}

/**
 * One write through the write path from background code (a subscriber, a queue job), as the
 * principal given: audited, refused or parked like any other, its in-process events published
 * after it commits. Give an idempotency key that is the same on every retry of the job.
 */
export async function writeAs(
  ctx: Pick<ServerContext, 'db' | 'get'>,
  a: { principal: Principal; requestId: string; idempotencyKey?: string },
  // biome-ignore lint/suspicious/noExplicitAny: any operation
  op: WriteOp<any, any, any>,
  input: unknown,
): Promise<WriteResult> {
  const out = await runWrite(ctx.db, a, op, input);
  const bus = ctx.get(EventBus);
  for (const event of out.events) bus.publish(event);
  return out.result;
}
