// /api/members and /api/grants: a business's people, its roles, invitations and per-record
// grants. People only (no agent tools yet). Reads check a capability; writes go through
// runWrite (ops.ts), so each is authorized, audited and passed through the write hooks.
import {
  AcceptInviteInput,
  AddGrantInput,
  type BusinessRoles,
  CreateInviteInput,
  capabilities,
  DefineRoleInput,
  EditRoleInput,
  FrameworkCapabilities,
  GrantsQuery,
  type Member,
  type Principal,
  rolesOfBusiness,
  SetMemberRolesInput,
} from '@hykr/contracts';
import {
  CurrentPrincipal,
  HumanOnlyGuard,
  PrincipalGuard,
  RequestMeta,
  type RequestMetaValue,
  requireCapability,
  runWrite,
  TenantConfigService,
  type WriteOp,
} from '@hykr/core';
import { type Database, memberInvites, memberships, recordGrants, user } from '@hykr/db';
import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { OptionalAuth } from '@thallesp/nestjs-better-auth';
import { and, asc, desc, eq } from 'drizzle-orm';
import { createZodDto } from 'nestjs-zod';
import { DB } from '../../infra/db.module.js';
import {
  acceptInvite,
  addGrant,
  createInvite,
  defineRole,
  editRole,
  reachable,
  removeGrant,
  removeMember,
  removeRole,
  revokeInvite,
  setMemberRoles,
  toGrant,
  toInvite,
  tokenHash,
} from './ops.js';

const READ = FrameworkCapabilities.readMembers;
const MANAGE = FrameworkCapabilities.manageMembers;
const GRANT = FrameworkCapabilities.grantRecords;

const refuse = (rule: string, reason: string) => ({ rule, reason });

// Bodies and queries, validated by the global zod pipe (400 with the issues).
class DefineRoleDto extends createZodDto(DefineRoleInput) {}
class EditRoleDto extends createZodDto(EditRoleInput) {}
class SetRolesDto extends createZodDto(SetMemberRolesInput) {}
class InviteDto extends createZodDto(CreateInviteInput) {}
class AcceptDto extends createZodDto(AcceptInviteInput) {}
class AddGrantDto extends createZodDto(AddGrantInput) {}
class GrantsQueryDto extends createZodDto(GrantsQuery) {}

// biome-ignore lint/suspicious/noExplicitAny: any members op
type AnyOp = WriteOp<any, any, any>;

/** Writes and their answers, shared by both controllers. */
class Writes {
  constructor(
    protected readonly db: Database,
    protected readonly tenants: TenantConfigService,
  ) {}

  protected async write(p: Principal, meta: RequestMetaValue, op: AnyOp, input: unknown) {
    const { result } = await runWrite(
      this.db,
      { principal: p, requestId: meta.requestId, idempotencyKey: meta.idempotencyKey },
      op,
      input ?? {},
    );
    return result;
  }

  /** A write that changed the business's roles: every process sees it within the cache's life. */
  protected async rolesWrite(p: Principal, meta: RequestMetaValue, op: AnyOp, input: unknown) {
    try {
      return await this.write(p, meta, op, input);
    } finally {
      if (p.tenantId) this.tenants.invalidate(p.tenantId);
    }
  }
}

@Controller('api/members')
@OptionalAuth()
@UseGuards(PrincipalGuard, HumanOnlyGuard)
export class MembersController extends Writes {
  constructor(@Inject(DB) db: Database, @Inject(TenantConfigService) tenants: TenantConfigService) {
    super(db, tenants);
  }

  /** The business's people and their roles. */
  @Get()
  async list(@CurrentPrincipal() p: Principal): Promise<Member[]> {
    requireCapability(p, READ, refuse('members_read', "Only the business's team sees its members"));
    const rows = await this.db
      .select({ m: memberships, name: user.name, email: user.email })
      .from(memberships)
      .innerJoin(user, eq(user.id, memberships.userId))
      .where(eq(memberships.tenantId, p.tenantId ?? ''))
      .orderBy(asc(memberships.createdAt));
    return rows.map(({ m, name, email }) => ({
      userId: m.userId,
      name,
      email,
      roles: m.roles,
      customerId: m.customerId,
      joinedAt: m.createdAt.toISOString(),
    }));
  }

  /** The business's roles (declared, with its edits, and its own) and every capability. */
  @Get('roles')
  async roles(@CurrentPrincipal() p: Principal): Promise<BusinessRoles> {
    requireCapability(p, READ, refuse('members_read', "Only the business's team sees its roles"));
    const { settings } = await this.tenants.get(p.tenantId ?? '');
    return {
      roles: rolesOfBusiness(settings),
      capabilities: capabilities.all().map((c) => ({
        name: c.name,
        label: c.label,
        grantable: c.grantable !== false,
      })),
    };
  }

  @Post('roles')
  @HttpCode(200)
  defineRole(
    @CurrentPrincipal() p: Principal,
    @RequestMeta() m: RequestMetaValue,
    @Body() body: DefineRoleDto,
  ) {
    return this.rolesWrite(p, m, defineRole(), body);
  }

  @Patch('roles/:name')
  editRole(
    @CurrentPrincipal() p: Principal,
    @RequestMeta() m: RequestMetaValue,
    @Param('name') name: string,
    @Body() body: EditRoleDto,
  ) {
    return this.rolesWrite(p, m, editRole(name), body);
  }

  @Delete('roles/:name')
  removeRole(
    @CurrentPrincipal() p: Principal,
    @RequestMeta() m: RequestMetaValue,
    @Param('name') name: string,
  ) {
    return this.rolesWrite(p, m, removeRole(name), {});
  }

  /** Invitations, newest first (the tokens are never shown again). */
  @Get('invites')
  async invites(@CurrentPrincipal() p: Principal) {
    requireCapability(
      p,
      MANAGE,
      refuse('members_manage', 'Only people who manage members see invitations'),
    );
    const rows = await this.db
      .select()
      .from(memberInvites)
      .where(eq(memberInvites.tenantId, p.tenantId ?? ''))
      .orderBy(desc(memberInvites.createdAt))
      .limit(200);
    return rows.map(toInvite);
  }

  @Post('invites')
  @HttpCode(200)
  invite(
    @CurrentPrincipal() p: Principal,
    @RequestMeta() m: RequestMetaValue,
    @Body() body: InviteDto,
  ) {
    // No idempotency key: a stored answer would keep the token in the database.
    return this.write(p, { requestId: m.requestId }, createInvite(), body);
  }

  /**
   * Join the business an invitation is for. The person must be signed in with the email it was
   * sent to; it works once, before it expires. An invitation that is unknown, used, taken back or
   * expired is 404 alike.
   */
  @Post('invites/accept')
  @HttpCode(200)
  async accept(
    @CurrentPrincipal() p: Principal,
    @RequestMeta() m: RequestMetaValue,
    @Body() input: AcceptDto,
  ) {
    if (p.actor.kind !== 'user' || p.assurance !== 'session')
      throw new ForbiddenException({
        error: 'forbidden',
        rule: 'needs_assurance',
        reason: 'Sign in to accept an invitation',
      });
    const [invite] = await this.db
      .select()
      .from(memberInvites)
      .where(eq(memberInvites.tokenHash, tokenHash(input.token)));
    if (
      !invite ||
      invite.acceptedAt ||
      invite.revokedAt ||
      invite.expiresAt.getTime() <= Date.now()
    )
      throw new NotFoundException({
        error: 'not_found',
        message: 'This invitation is not valid any more',
      });
    const [me] = await this.db
      .select({ email: user.email })
      .from(user)
      .where(eq(user.id, p.actor.id));
    if (!me || me.email.toLowerCase() !== invite.email)
      throw new ForbiddenException({
        error: 'forbidden',
        rule: 'invite_email',
        reason: 'This invitation is for another email address',
      });
    // The write happens in the invitation's business, where the person has no roles yet.
    const joining: Principal = {
      actor: { kind: 'user', id: p.actor.id },
      subject: { kind: 'user', userId: p.actor.id },
      tenantId: invite.tenantId,
      roles: [],
      capabilities: [],
      assurance: p.assurance,
      scopes: [],
      ...(p.channel ? { channel: p.channel } : {}),
    };
    return this.write(joining, m, acceptInvite(invite.id), input);
  }

  @Delete('invites/:id')
  revoke(
    @CurrentPrincipal() p: Principal,
    @RequestMeta() m: RequestMetaValue,
    @Param('id') id: string,
  ) {
    return this.write(p, m, revokeInvite(id), {});
  }

  @Patch(':userId')
  setRoles(
    @CurrentPrincipal() p: Principal,
    @RequestMeta() m: RequestMetaValue,
    @Param('userId') userId: string,
    @Body() body: SetRolesDto,
  ) {
    return this.write(p, m, setMemberRoles(userId), body);
  }

  @Delete(':userId')
  remove(
    @CurrentPrincipal() p: Principal,
    @RequestMeta() m: RequestMetaValue,
    @Param('userId') userId: string,
  ) {
    return this.write(p, m, removeMember(userId), {});
  }
}

@Controller('api/grants')
@OptionalAuth()
@UseGuards(PrincipalGuard, HumanOnlyGuard)
export class GrantsController extends Writes {
  constructor(@Inject(DB) db: Database, @Inject(TenantConfigService) tenants: TenantConfigService) {
    super(db, tenants);
  }

  /** Who holds a grant on one record. The record must be one the person reaches. */
  @Get()
  async list(@CurrentPrincipal() p: Principal, @Query() q: GrantsQueryDto) {
    requireCapability(
      p,
      GRANT,
      refuse('records_grant', 'Only people who give access to records see it'),
    );
    await reachable(this.db, p, q.resourceType, q.resourceId);
    const rows = await this.db
      .select()
      .from(recordGrants)
      .where(
        and(
          eq(recordGrants.tenantId, p.tenantId ?? ''),
          eq(recordGrants.resourceType, q.resourceType),
          eq(recordGrants.resourceId, q.resourceId),
        ),
      )
      .orderBy(asc(recordGrants.createdAt));
    return rows.map(toGrant);
  }

  @Post()
  @HttpCode(200)
  add(
    @CurrentPrincipal() p: Principal,
    @RequestMeta() m: RequestMetaValue,
    @Body() body: AddGrantDto,
  ) {
    return this.write(p, m, addGrant(), body);
  }

  @Delete(':id')
  remove(
    @CurrentPrincipal() p: Principal,
    @RequestMeta() m: RequestMetaValue,
    @Param('id') id: string,
  ) {
    return this.write(p, m, removeGrant(id), {});
  }
}
