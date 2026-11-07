import {
  givenRoles,
  knownRoles,
  type Me,
  type Principal,
  SetDefaultBusinessInput,
} from '@hykr/contracts';
import {
  allow,
  CurrentPrincipal,
  HumanOnlyGuard,
  PrincipalGuard,
  RequestMeta,
  type RequestMetaValue,
  runWrite,
  type WriteOp,
} from '@hykr/core';
import { businessesOf, type Database, memberships } from '@hykr/db';
import {
  Body,
  Controller,
  Get,
  Inject,
  Module,
  NotFoundException,
  Put,
  UseGuards,
} from '@nestjs/common';
import { OptionalAuth } from '@thallesp/nestjs-better-auth';
import { and, eq } from 'drizzle-orm';
import { createZodDto } from 'nestjs-zod';
import { DB } from '../../infra/db.module.js';

class SetDefaultDto extends createZodDto(SetDefaultBusinessInput) {}

type MembershipRow = typeof memberships.$inferSelect;
const membershipJson = (m: MembershipRow) => ({
  tenantId: m.tenantId,
  userId: m.userId,
  roles: m.roles,
  customerId: m.customerId,
  isDefault: m.isDefault,
});

/**
 * One of the person's memberships becomes the business their sessions work in when they name
 * none. Audited in that business. A business they are no member of (one they only participate
 * in, another person's) is 404.
 */
const setDefault = (): WriteOp<SetDefaultBusinessInput, MembershipRow, string> => ({
  name: 'me.default',
  kind: 'command',
  resourceType: 'membership',
  input: SetDefaultBusinessInput,
  resourceId: (_input, m) => m.userId,
  async load(tx, p, input) {
    const [m] = await tx
      .select()
      .from(memberships)
      .where(and(eq(memberships.tenantId, input.tenantId), eq(memberships.userId, p.actor.id)));
    if (!m) throw new NotFoundException({ error: 'not_found', message: 'No such business' });
    return m;
  },
  authorize: () => allow('own_default', 'Chooses the business they work in by default'),
  summarize: () => 'Work in this business by default',
  async run({ tx, loaded }) {
    if (loaded.isDefault) return { value: loaded.tenantId, touched: [] };
    await tx
      .update(memberships)
      .set({ isDefault: false })
      .where(and(eq(memberships.userId, loaded.userId), eq(memberships.isDefault, true)));
    const [after] = await tx
      .update(memberships)
      .set({ isDefault: true })
      .where(and(eq(memberships.tenantId, loaded.tenantId), eq(memberships.userId, loaded.userId)))
      .returning();
    return {
      value: loaded.tenantId,
      touched: [
        {
          type: 'membership',
          id: loaded.userId,
          change: 'updated',
          before: membershipJson(loaded),
          after: membershipJson(after),
        },
      ],
    };
  },
  present: (tenantId) => ({ tenantId }),
});

/**
 * Who the signed-in person is, in the business they are working in (roles and what they allow,
 * as a member or a participant), and every business they are in, for a switcher.
 */
@Controller('api/me')
@OptionalAuth()
@UseGuards(PrincipalGuard, HumanOnlyGuard)
export class MeController {
  constructor(@Inject(DB) private readonly db: Database) {}

  @Get()
  async me(@CurrentPrincipal() p: Principal): Promise<Me> {
    const participant = knownRoles(givenRoles('participant'));
    const businesses = (await businessesOf(this.db, p.actor.id)).map((b) => ({
      ...b,
      roles: b.as === 'participant' ? participant : b.roles,
    }));
    return {
      userId: p.actor.id,
      tenantId: p.tenantId ?? null,
      roles: p.roles ?? [],
      capabilities: p.capabilities ?? [],
      customerId: p.customerId ?? null,
      as: p.tenantId ? (p.standing ?? 'member') : null,
      businesses,
    };
  }

  /** Work in this business by default (one of the person's memberships). */
  @Put('default')
  async setDefault(
    @CurrentPrincipal() p: Principal,
    @RequestMeta() m: RequestMetaValue,
    @Body() body: SetDefaultDto,
  ) {
    // The write happens in the chosen business, as the person (their membership there).
    const there: Principal = {
      actor: { kind: 'user', id: p.actor.id },
      subject: { kind: 'user', userId: p.actor.id },
      tenantId: body.tenantId,
      roles: [],
      capabilities: [],
      assurance: p.assurance,
      scopes: [],
      ...(p.channel ? { channel: p.channel } : {}),
    };
    const { result } = await runWrite(
      this.db,
      { principal: there, requestId: m.requestId, idempotencyKey: m.idempotencyKey },
      setDefault(),
      body,
    );
    return result;
  }
}

@Module({ controllers: [MeController] })
export class MeModule {}
