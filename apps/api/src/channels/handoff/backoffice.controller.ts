import type { ChannelAdapter, OutboundMessage } from '@app/channels';
import { type Principal, RequestHumanInput, type TenantRole } from '@app/contracts';
import { CurrentPrincipal, HumanOnlyGuard, PrincipalGuard } from '@app/core';
import { type Database, schema, writeAudit } from '@app/db';
import { langOf } from '@app/i18n';
import { HandoffReply } from '@app/notifications';
import {
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { OptionalAuth } from '@thallesp/nestjs-better-auth';
import { and, asc, desc, eq, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import { DB } from '../../infra/db.module.js';
import { ChatService } from '../../modules/chat/chat.service.js';
import { ThreadsService } from '../../modules/threads/threads.service.js';
import { type Contact, ContactsService, WINDOW_MS } from '../contacts.service.js';
import { OutboundService } from '../outbound.service.js';
import { TemplateSync } from '../templates/template-sync.js';
import { TenantsService } from '../tenants.service.js';
import { WHATSAPP } from '../whatsapp/adapter.provider.js';
import { type Handoff, HandoffService } from './handoff.service.js';

const { handoffs, contacts, templates } = schema;
const STAFF: readonly TenantRole[] = ['owner', 'admin', 'ops', 'staff'];

/** Less than this left in the 24-hour window: answer soon, or only a template will reach them. */
const WAITING_MS = 2 * 60 * 60 * 1000;

const ReplyInput = z.object({ text: z.string().trim().min(1).max(1000) });
const ReturnInput = z.object({ resolution: z.string().trim().max(500).optional() });
const ConsentInput = z.object({
  topic: z.enum(['service', 'reminders', 'marketing']),
  granted: z.boolean(),
  /** How they said it: "on the phone, 8 Oct". */
  note: z.string().trim().max(200).optional(),
});

function staffOnly(p: Principal) {
  if (!p.roles?.some((r) => STAFF.includes(r)))
    throw new ForbiddenException({
      error: 'forbidden',
      rule: 'staff_only',
      reason: 'The back office is for the business',
    });
}

/**
 * The back office: conversations a person has taken from the assistant. Staff see their
 * business's open handoffs, take one, reply (as text inside the 24-hour window, as the
 * handoff_reply template outside it), ask the assistant for a draft, and hand it back.
 */
@Controller('api/backoffice')
@OptionalAuth()
@UseGuards(PrincipalGuard, HumanOnlyGuard)
export class BackOfficeController {
  private readonly sync: TemplateSync;

  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly contacts: ContactsService,
    private readonly outbound: OutboundService,
    private readonly threads: ThreadsService,
    private readonly tenants: TenantsService,
    private readonly chat: ChatService,
    @Inject(WHATSAPP) wa: ChannelAdapter,
  ) {
    this.sync = new TemplateSync(db, wa, '');
  }

  /** Open, mine, and waiting (the window closes within two hours). Flagged ones first. */
  @Get('inbox')
  async inbox(@CurrentPrincipal() p: Principal) {
    staffOnly(p);
    const rows = await this.db
      .select({ handoff: handoffs, contact: contacts })
      .from(handoffs)
      .innerJoin(contacts, eq(contacts.id, handoffs.contactId))
      .where(and(eq(handoffs.tenantId, p.tenantId ?? ''), ne(handoffs.state, 'closed')))
      .orderBy(sql`${handoffs.flaggedAt} desc nulls last`, asc(handoffs.openedAt));
    const items = await Promise.all(rows.map((r) => this.item(r.handoff, r.contact)));
    const me = p.actor.id;
    const now = Date.now();
    return {
      open: items.filter((i) => i.state === 'open'),
      mine: items.filter((i) => i.takenBy === me),
      waiting: items.filter(
        (i) => i.windowEndsAt && new Date(i.windowEndsAt).getTime() - now < WAITING_MS,
      ),
    };
  }

  @Get('handoffs/:id')
  async get(@CurrentPrincipal() p: Principal, @Param('id') id: string) {
    staffOnly(p);
    const { handoff, contact } = await this.load(p, id);
    return {
      ...(await this.item(handoff, contact)),
      messages: (await this.threads.messages(handoff.threadId)).map((m) => ({
        id: m.id,
        role: m.role,
        text: m.parts
          .flatMap((part) => (part.type === 'text' ? [String(part.text ?? '')] : []))
          .join('\n'),
        at: m.metadata.createdAt,
      })),
    };
  }

  @Post('handoffs/:id/take')
  @HttpCode(200)
  async take(@CurrentPrincipal() p: Principal, @Param('id') id: string) {
    staffOnly(p);
    const { handoff, contact } = await this.load(p, id);
    const [row] = await this.db
      .update(handoffs)
      .set({ state: 'taken', takenBy: p.actor.id, takenAt: new Date() })
      .where(and(eq(handoffs.id, handoff.id), ne(handoffs.state, 'closed')))
      .returning();
    if (!row) throw new ConflictException({ error: 'closed', reason: 'Already handed back' });
    await this.audit(p, 'handoff.taken', row);
    return this.item(row, contact);
  }

  /** Inside the window: their words as text. Outside it: the approved reply template. */
  @Post('handoffs/:id/reply')
  @HttpCode(200)
  async reply(@CurrentPrincipal() p: Principal, @Param('id') id: string, @Body() body: unknown) {
    staffOnly(p);
    const { text } = ReplyInput.parse(body);
    const { handoff, contact } = await this.load(p, id);
    if (handoff.state === 'closed') throw new ConflictException({ error: 'closed' });
    const from = await this.contacts.numberOfTenant(contact.tenantId);
    if (!from) throw new ConflictException({ error: 'no_number', reason: 'No WhatsApp number' });
    let message: OutboundMessage = { kind: 'text', to: contact.address, text };
    if (!(await this.contacts.windowOpen(contact.id))) {
      const lang = langOf(contact.locale);
      const approved = (await this.sync.approved(HandoffReply.name, lang))
        ? lang
        : (await this.sync.approved(HandoffReply.name, 'en'))
          ? 'en'
          : undefined;
      if (!approved)
        throw new ConflictException({
          error: 'window_closed',
          reason: `Their 24 hours have passed and ${HandoffReply.name} is not approved yet`,
        });
      const { name } = await this.tenants.get(contact.tenantId);
      message = {
        kind: 'template',
        to: contact.address,
        name: HandoffReply.name,
        language: approved,
        params: { business: name.slice(0, 60), message: text.slice(0, 600) },
      };
    }
    await this.outbound.queue({ tenantId: contact.tenantId, contactId: contact.id, from }, [
      message,
    ]);
    await this.threads.append({
      threadId: handoff.threadId,
      role: 'assistant',
      text,
      channel: 'whatsapp',
    });
    // Replying takes it, if nobody had.
    if (handoff.state === 'open')
      await this.db
        .update(handoffs)
        .set({ state: 'taken', takenBy: p.actor.id, takenAt: new Date(), flaggedAt: null })
        .where(eq(handoffs.id, handoff.id));
    await this.audit(p, 'handoff.replied', handoff, { as: message.kind });
    return { sent: message.kind };
  }

  /** The assistant's suggestion, for staff to edit; nothing is sent. */
  @Post('handoffs/:id/draft')
  @HttpCode(200)
  async draft(@CurrentPrincipal() p: Principal, @Param('id') id: string) {
    staffOnly(p);
    const { handoff, contact } = await this.load(p, id);
    const history = await this.threads.history(handoff.threadId, 20);
    return { text: await this.chat.draft(p, history, langOf(contact.locale)) };
  }

  /** Back to the assistant, with a note in the thread so it knows what staff resolved. */
  @Post('handoffs/:id/return')
  @HttpCode(200)
  async giveBack(@CurrentPrincipal() p: Principal, @Param('id') id: string, @Body() body: unknown) {
    staffOnly(p);
    const { resolution } = ReturnInput.parse(body ?? {});
    const { handoff } = await this.load(p, id);
    const [row] = await this.db
      .update(handoffs)
      .set({ state: 'closed', closedAt: new Date(), resolution: resolution ?? null })
      .where(and(eq(handoffs.id, handoff.id), ne(handoffs.state, 'closed')))
      .returning();
    if (!row) throw new ConflictException({ error: 'closed', reason: 'Already handed back' });
    await this.threads.append({
      threadId: handoff.threadId,
      role: 'assistant',
      text: `(A person from the team handled this conversation${resolution ? `: ${resolution}` : ''}. The assistant answers again from here.)`,
      channel: 'whatsapp',
    });
    await this.audit(p, 'handoff.returned', row);
    return { state: row.state };
  }

  /** What Meta has said about each template: approved, pending, rejected and why. */
  @Get('templates')
  async templates(@CurrentPrincipal() p: Principal) {
    staffOnly(p);
    return this.db
      .select({
        name: templates.name,
        language: templates.language,
        category: templates.category,
        status: templates.status,
        rejectedReason: templates.rejectedReason,
        syncedAt: templates.syncedAt,
      })
      .from(templates)
      .orderBy(asc(templates.name), asc(templates.language));
  }

  /** Consent a customer gave (or withdrew) outside WhatsApp: on the phone, at the counter. */
  @Post('contacts/:id/consent')
  @HttpCode(200)
  async consent(@CurrentPrincipal() p: Principal, @Param('id') id: string, @Body() body: unknown) {
    staffOnly(p);
    const input = ConsentInput.parse(body);
    const [contact] = await this.db
      .select()
      .from(contacts)
      .where(and(eq(contacts.id, id), eq(contacts.tenantId, p.tenantId ?? '')));
    if (!contact) throw new NotFoundException({ error: 'not_found' });
    await this.contacts.setConsent(contact.id, input.topic, input.granted, `staff:${p.actor.id}`);
    await writeAudit(this.db, {
      action: 'channel.consent.recorded',
      resourceType: 'contact',
      resourceId: contact.id,
      actorKind: 'user',
      actorId: p.actor.id,
      tenantId: contact.tenantId,
      channel: 'app',
      after: { topic: input.topic, granted: input.granted, note: input.note ?? null },
    });
    return { topic: input.topic, granted: input.granted };
  }

  private async load(p: Principal, id: string) {
    const [row] = await this.db
      .select({ handoff: handoffs, contact: contacts })
      .from(handoffs)
      .innerJoin(contacts, eq(contacts.id, handoffs.contactId))
      .where(and(eq(handoffs.id, id), eq(handoffs.tenantId, p.tenantId ?? '')));
    if (!row) throw new NotFoundException({ error: 'not_found' });
    return row;
  }

  private async item(h: Handoff, c: Contact) {
    const last = await this.contacts.lastInboundAt(c.id);
    return {
      id: h.id,
      state: h.state,
      reason: h.reason,
      takenBy: h.takenBy,
      openedAt: h.openedAt,
      flagged: h.flaggedAt !== null,
      contact: { id: c.id, name: c.profileName, address: c.address, locale: c.locale },
      lastInboundAt: last ?? null,
      windowEndsAt: last ? new Date(last.getTime() + WINDOW_MS) : null,
    };
  }

  private audit(p: Principal, action: string, h: Handoff, after: object = {}) {
    return writeAudit(this.db, {
      action,
      resourceType: 'handoff',
      resourceId: h.id,
      actorKind: 'user',
      actorId: p.actor.id,
      tenantId: h.tenantId,
      channel: 'app',
      after: { state: h.state, ...after },
    });
  }
}

/**
 * The assistant's request-human tool: this WhatsApp conversation goes to a person. A contact
 * asks for themselves; a person with an account, for their linked number in this business.
 */
@Controller('api/handoff')
@OptionalAuth()
@UseGuards(PrincipalGuard)
export class HandoffRequestController {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly handoffs: HandoffService,
    private readonly contacts: ContactsService,
  ) {}

  @Post()
  @HttpCode(200)
  async request(@CurrentPrincipal() p: Principal, @Body() body: unknown) {
    RequestHumanInput.parse(body);
    const subject = p.subject;
    let contact: Contact | undefined;
    if (subject?.kind === 'contact') contact = await this.contacts.byId(subject.contactId);
    else if (subject?.kind === 'user')
      [contact] = await this.db
        .select()
        .from(contacts)
        .where(and(eq(contacts.tenantId, p.tenantId ?? ''), eq(contacts.userId, subject.userId)))
        .orderBy(desc(contacts.linkedAt))
        .limit(1);
    if (!contact || p.channel !== 'whatsapp')
      throw new ForbiddenException({
        error: 'forbidden',
        rule: 'not_on_whatsapp',
        reason: 'Only a WhatsApp conversation can be handed to a person',
      });
    await this.handoffs.open(contact, 'agent_tool');
    return { status: 'done', value: { opened: true } };
  }
}
