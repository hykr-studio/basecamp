import {
  type Assurance,
  type Channel,
  checkRoles,
  givenRoles,
  type Principal,
  parseSubjectKey,
  type RolesSettings,
  type Subject,
  standingIn,
} from '@hykr/contracts';
import { contactById, ensureDefaultTenant, membershipOf, userExists } from '@hykr/db';
import {
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { TenantConfigService } from '../tenants/tenant-config.service.js';
import { CORE_OPTIONS, type CoreOptions } from '../tokens.js';

/** The part of a principal that says who it is for and what they may do, in which business. */
export type Standing = Required<
  Pick<Principal, 'subject' | 'tenantId' | 'roles' | 'capabilities' | 'assurance'>
> &
  Pick<Principal, 'customerId'>;

/**
 * How sure a channel makes us, at most: WhatsApp vouches only for a number, and a share link
 * for even less until it asks for a code. A channel can only lower assurance, never raise it.
 */
const CHANNEL_ASSURANCE: Record<Channel, Assurance> = {
  app: 'session',
  voice: 'session',
  api: 'session',
  mcp: 'session',
  webmcp: 'session',
  background: 'session',
  whatsapp: 'whatsapp_number',
  share: 'whatsapp_number',
};

const logger = new Logger('PrincipalResolver');
const warned = new Set<string>();

/**
 * Roles and what they allow in this business, as a principal carries them: the declared roles
 * (with the application's overrides and the business's edits) and the business's own. A name
 * it does not have grants nothing, and is logged once.
 */
function standingOf(values: readonly string[], section: RolesSettings | null) {
  const { roles, capabilities, unknown } = standingIn(values, section ? { roles: section } : {});
  for (const r of unknown)
    if (!warned.has(r)) {
      warned.add(r);
      logger.warn(`Role "${r}" is in a membership but nobody declared it: it grants nothing`);
    }
  // A roles section that does not parse may hide an edit that took capabilities away: allow none.
  return { roles, capabilities: section ? capabilities : [] };
}

/**
 * Who a request is for, from facts the server holds: the session, the person or contact an
 * agent names, their membership and roles in the business, and how sure we are of them.
 * Nothing here comes from a request body; headers only choose among what the server allows
 * (a tenant the person belongs to), and can only lower assurance, never raise it.
 */
@Injectable()
export class PrincipalResolver {
  constructor(
    @Inject(CORE_OPTIONS) private readonly options: CoreOptions,
    @Inject(TenantConfigService) private readonly tenants: TenantConfigService,
  ) {
    // When the API or worker starts: a role, override or role default naming a capability or
    // role nobody declares stops it.
    checkRoles();
  }

  /**
   * A business's roles section. It is read alone, so another broken section (a feature's) leaves
   * the capabilities in place and its owner can still repair it. A roles section that does not
   * parse is null: the declared roles still reach their rows, but nobody holds a capability
   * there until it is fixed (fail closed: a business's edit may have taken some away).
   */
  private async rolesOf(tenantId: string): Promise<RolesSettings | null> {
    try {
      return await this.tenants.section(tenantId, 'roles');
    } catch (e) {
      logger.error(`Roles of business ${tenantId} do not parse; no capabilities there: ${e}`);
      return null;
    }
  }

  /**
   * A person, in a business they belong to (that one, or their default). A WhatsApp turn is
   * only as sure as the number: 'whatsapp_number', even for a person with an account.
   */
  async forUser(
    userId: string,
    opts: { tenantId?: string; channel?: Channel; name?: string } = {},
  ): Promise<Standing> {
    const db = this.options.db;
    let membership = await membershipOf(db, userId, opts.tenantId);
    if (!membership && opts.tenantId)
      throw new ForbiddenException({ error: 'forbidden', rule: 'not_a_member' });
    // A person without a business yet (signed up before the hook, or it failed): give them one.
    if (!membership) {
      if (!(await userExists(db, userId))) throw new UnauthorizedException('Unknown person');
      membership = await ensureDefaultTenant(db, userId, opts.name ?? '');
    }
    return {
      subject: { kind: 'user', userId },
      tenantId: membership.tenantId,
      ...standingOf(membership.roles, await this.rolesOf(membership.tenantId)),
      ...(membership.customerId ? { customerId: membership.customerId } : {}),
      assurance: this.assurance(opts.channel),
    };
  }

  /**
   * A WhatsApp contact. Linked to an account (and a member of this business): that person,
   * at 'whatsapp_number'. Otherwise the business's customer, seeing only their own records.
   * A contact belongs to one business: asked for another one (a credential or header that
   * fixes it), it is refused, never moved there.
   */
  async forContact(
    contactId: string,
    opts: { tenantId?: string; channel?: Channel } = {},
  ): Promise<Standing> {
    const contact = await contactById(this.options.db, contactId);
    if (!contact) throw new UnauthorizedException('Unknown contact');
    if (opts.tenantId && opts.tenantId !== contact.tenantId)
      throw new ForbiddenException({ error: 'forbidden', rule: 'tenant_mismatch' });
    if (contact.userId) {
      const member = await membershipOf(this.options.db, contact.userId, contact.tenantId);
      if (member)
        return this.forUser(contact.userId, {
          tenantId: contact.tenantId,
          channel: opts.channel ?? 'whatsapp',
        });
    }
    return {
      subject: { kind: 'contact', contactId },
      tenantId: contact.tenantId,
      // The roles the application gives a contact (the framework's: customer).
      ...standingOf(givenRoles('contact'), await this.rolesOf(contact.tenantId)),
      ...(contact.customerId ? { customerId: contact.customerId } : {}),
      assurance: 'whatsapp_number',
    };
  }

  /** Whom an agent names (x-acting-for): "user:<id>", "contact:<id>", or a bare user id. */
  async forActingFor(
    value: string,
    opts: { tenantId?: string; channel?: Channel } = {},
  ): Promise<Standing> {
    const subject = parseSubjectKey(value);
    if (!subject) throw new UnauthorizedException('x-acting-for names nobody');
    return this.forSubject(subject, opts);
  }

  forSubject(subject: Subject, opts: { tenantId?: string; channel?: Channel } = {}) {
    return subject.kind === 'user'
      ? this.forUser(subject.userId, opts)
      : this.forContact(subject.contactId, opts);
  }

  /**
   * A stored principal (a parked approval), checked again before it acts: the person must
   * still belong to the business, the contact must still exist. Its roles are today's.
   */
  async refresh(stored: Principal): Promise<Principal> {
    const subject =
      stored.subject ??
      (stored.actor.kind === 'user'
        ? ({ kind: 'user', userId: stored.actor.id } as const)
        : stored.actingFor?.userId
          ? ({ kind: 'user', userId: stored.actingFor.userId } as const)
          : undefined);
    if (!subject) throw new ForbiddenException({ error: 'forbidden', rule: 'nobody_to_act_for' });
    const standing = await this.forSubject(subject, {
      tenantId: stored.tenantId,
      channel: stored.channel,
    });
    return { ...stored, ...standing };
  }

  private assurance(channel: Channel | undefined): Assurance {
    // An unknown channel (an old stored principal) counts as the weakest.
    return channel ? (CHANNEL_ASSURANCE[channel] ?? 'whatsapp_number') : 'session';
  }
}
