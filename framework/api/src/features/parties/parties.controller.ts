// /api/parties and /api/participants: the people and organisations a business works with, how
// each is reached, and who participates in which record. People only (no agent tools yet). Reads
// check a capability (and, for a record's participants, that the person reaches the record);
// writes go through runWrite (ops.ts), so each is authorized, audited and passed through the
// write hooks.
import {
  AddParticipantInput,
  AddPartyMemberInput,
  CreatePartyInput,
  EditPartyInput,
  JoinPartyInput,
  PARTY_KINDS,
  type ParticipantRoleView,
  ParticipantsQuery,
  type Participation,
  PartiesQuery,
  type Party,
  PartyCapabilities,
  type Principal,
  participantRoles,
} from '@hykr/contracts';
import {
  CurrentPrincipal,
  HumanOnlyGuard,
  PrincipalGuard,
  RequestMeta,
  type RequestMetaValue,
  requireCapability,
  runWrite,
  type WriteOp,
} from '@hykr/core';
import { contacts, type Database, participations, parties, partyMembers, user } from '@hykr/db';
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
import { and, asc, eq, ilike } from 'drizzle-orm';
import { createZodDto } from 'nestjs-zod';
import { DB } from '../../infra/db.module.js';
import { reachable, tokenHash } from '../members/ops.js';
import {
  addMember,
  addParticipant,
  createParty,
  editParty,
  joinParty,
  notFound,
  removeMember,
  removeParticipant,
  removeParty,
  tenantOf,
  toMember,
  toParticipation,
  toParty,
} from './ops.js';

const READ = PartyCapabilities.read;

const refuse = (reason: string) => ({ rule: 'parties_read', reason });

// Bodies and queries, validated by the global zod pipe (400 with the issues).
class CreatePartyDto extends createZodDto(CreatePartyInput) {}
class EditPartyDto extends createZodDto(EditPartyInput) {}
class AddMemberDto extends createZodDto(AddPartyMemberInput) {}
class JoinDto extends createZodDto(JoinPartyInput) {}
class PartiesQueryDto extends createZodDto(PartiesQuery) {}
class AddParticipantDto extends createZodDto(AddParticipantInput) {}
class ParticipantsQueryDto extends createZodDto(ParticipantsQuery) {}

// biome-ignore lint/suspicious/noExplicitAny: any parties op
type AnyOp = WriteOp<any, any, any>;

/** Writes and their answers, shared by both controllers. */
class Writes {
  constructor(protected readonly db: Database) {}

  protected async write(p: Principal, meta: RequestMetaValue, op: AnyOp, input: unknown) {
    const { result } = await runWrite(
      this.db,
      { principal: p, requestId: meta.requestId, idempotencyKey: meta.idempotencyKey },
      op,
      input ?? {},
    );
    return result;
  }
}

/** A like pattern for a search: its own % and _ taken literally. */
const contains = (q: string) => `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

@Controller('api/parties')
@OptionalAuth()
@UseGuards(PrincipalGuard, HumanOnlyGuard)
export class PartiesController extends Writes {
  constructor(@Inject(DB) db: Database) {
    super(db);
  }

  /** The business's parties, by name: of one kind, of one customer, or matching a search. */
  @Get()
  async list(@CurrentPrincipal() p: Principal, @Query() q: PartiesQueryDto): Promise<Party[]> {
    requireCapability(p, READ, refuse("Only the business's team sees its parties"));
    const rows = await this.db
      .select()
      .from(parties)
      .where(
        and(
          eq(parties.tenantId, tenantOf(p)),
          q.kind ? eq(parties.kind, q.kind) : undefined,
          q.customerId ? eq(parties.customerId, q.customerId) : undefined,
          q.q ? ilike(parties.name, contains(q.q)) : undefined,
        ),
      )
      .orderBy(asc(parties.name), asc(parties.createdAt))
      .limit(500);
    return rows.map(toParty);
  }

  @Post()
  @HttpCode(200)
  create(
    @CurrentPrincipal() p: Principal,
    @RequestMeta() m: RequestMetaValue,
    @Body() body: CreatePartyDto,
  ) {
    return this.write(p, m, createParty(), body);
  }

  /**
   * Join a party with the link someone shared: signed in, with the email it was sent to, once,
   * before it expires. Unknown, used, removed or expired: 404 alike. The person becomes a
   * participant of that business, never a member.
   */
  @Post('join')
  @HttpCode(200)
  async join(
    @CurrentPrincipal() p: Principal,
    @RequestMeta() m: RequestMetaValue,
    @Body() input: JoinDto,
  ) {
    if (p.actor.kind !== 'user' || p.assurance !== 'session')
      throw new ForbiddenException({
        error: 'forbidden',
        rule: 'needs_assurance',
        reason: 'Sign in to accept an invitation',
      });
    const [invite] = await this.db
      .select()
      .from(partyMembers)
      .where(eq(partyMembers.tokenHash, tokenHash(input.token)));
    if (!invite || invite.joinedAt || !invite.expiresAt || invite.expiresAt.getTime() <= Date.now())
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
    // The write happens in the party's business, where the person holds no role.
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
    return this.write(joining, m, joinParty(invite.id), input);
  }

  /** One party, with how each of its people is reached. */
  @Get(':id')
  async get(@CurrentPrincipal() p: Principal, @Param('id') id: string): Promise<Party> {
    requireCapability(p, READ, refuse("Only the business's team sees its parties"));
    const [row] = await this.db
      .select()
      .from(parties)
      .where(and(eq(parties.id, id), eq(parties.tenantId, tenantOf(p))));
    if (!row) throw notFound('party');
    const members = await this.db
      .select({ m: partyMembers, address: contacts.address })
      .from(partyMembers)
      .leftJoin(contacts, eq(contacts.id, partyMembers.contactId))
      .where(and(eq(partyMembers.partyId, row.id), eq(partyMembers.tenantId, row.tenantId)))
      .orderBy(asc(partyMembers.createdAt));
    return { ...toParty(row), members: members.map((x) => toMember(x.m, x.address)) };
  }

  @Patch(':id')
  edit(
    @CurrentPrincipal() p: Principal,
    @RequestMeta() m: RequestMetaValue,
    @Param('id') id: string,
    @Body() body: EditPartyDto,
  ) {
    return this.write(p, m, editParty(id), body);
  }

  @Delete(':id')
  remove(
    @CurrentPrincipal() p: Principal,
    @RequestMeta() m: RequestMetaValue,
    @Param('id') id: string,
  ) {
    return this.write(p, m, removeParty(id), {});
  }

  /** Reach the party's person on WhatsApp ({ address }), or invite them by email ({ email }). */
  @Post(':id/members')
  @HttpCode(200)
  addMember(
    @CurrentPrincipal() p: Principal,
    @RequestMeta() m: RequestMetaValue,
    @Param('id') id: string,
    @Body() body: AddMemberDto,
  ) {
    // An invitation's answer holds its token: no idempotency key, so it is never stored.
    const meta = body.email ? { requestId: m.requestId } : m;
    return this.write(p, meta, addMember(id), body);
  }

  @Delete(':id/members/:memberId')
  removeMember(
    @CurrentPrincipal() p: Principal,
    @RequestMeta() m: RequestMetaValue,
    @Param('id') id: string,
    @Param('memberId') memberId: string,
  ) {
    return this.write(p, m, removeMember(id, memberId), {});
  }
}

@Controller('api/participants')
@OptionalAuth()
@UseGuards(PrincipalGuard, HumanOnlyGuard)
export class ParticipantsController extends Writes {
  constructor(@Inject(DB) db: Database) {
    super(db);
  }

  /** The participant roles the application declares, for a picker. */
  @Get('roles')
  roles(@CurrentPrincipal() p: Principal): ParticipantRoleView[] {
    requireCapability(p, READ, refuse("Only the business's team sees participant roles"));
    return participantRoles.all().map((r) => ({
      name: r.name,
      label: r.label,
      kinds: [...(r.kinds ?? PARTY_KINDS)],
      on: r.on ? [...r.on] : null,
    }));
  }

  /** Who participates in one record, and as what. The record must be one the person reaches. */
  @Get()
  async list(
    @CurrentPrincipal() p: Principal,
    @Query() q: ParticipantsQueryDto,
  ): Promise<Participation[]> {
    requireCapability(p, READ, refuse("Only the business's team sees who participates"));
    await reachable(this.db, p, q.resourceType, q.resourceId);
    const rows = await this.db
      .select({ x: participations, name: parties.name, kind: parties.kind })
      .from(participations)
      .innerJoin(parties, eq(parties.id, participations.partyId))
      .where(
        and(
          eq(participations.tenantId, tenantOf(p)),
          eq(participations.resourceType, q.resourceType),
          eq(participations.resourceId, q.resourceId),
        ),
      )
      .orderBy(asc(participations.createdAt));
    return rows.map((r) => toParticipation(r.x, r));
  }

  @Post()
  @HttpCode(200)
  add(
    @CurrentPrincipal() p: Principal,
    @RequestMeta() m: RequestMetaValue,
    @Body() body: AddParticipantDto,
  ) {
    return this.write(p, m, addParticipant(), body);
  }

  @Delete(':id')
  remove(
    @CurrentPrincipal() p: Principal,
    @RequestMeta() m: RequestMetaValue,
    @Param('id') id: string,
  ) {
    return this.write(p, m, removeParticipant(id), {});
  }
}
