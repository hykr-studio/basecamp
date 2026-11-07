// A member as a principal, for work done for them in the background: reading a record as they
// may see it (their calendar, their feed, an invite they asked for), or a module's subscriber
// writing as the person who changed something in their own calendar.
import type { Channel, Principal } from '@hykr/contracts';
import { PrincipalResolver } from '@hykr/core';
import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
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
