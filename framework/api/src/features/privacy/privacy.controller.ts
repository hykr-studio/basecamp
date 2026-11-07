import {
  ListPrivacyRequestsQuery,
  PRIVACY_REQUEST,
  type Principal,
  type PrivacyConfiguration,
  PrivacyManageCapability,
  type PrivacyRegister,
  type PrivacyRequest,
} from '@hykr/contracts';
import {
  CORE_OPTIONS,
  type CoreOptions,
  CurrentPrincipal,
  HumanOnlyGuard,
  PrincipalGuard,
  projectRead,
  requireCapability,
  settingsIn,
  tenantOf,
} from '@hykr/core';
import { type Database, privacyRequests } from '@hykr/db';
import { LANGS, type Lang } from '@hykr/i18n';
import { can, subjectOf } from '@hykr/policy';
import {
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import { OptionalAuth } from '@thallesp/nestjs-better-auth';
import { and, desc, eq, type SQL } from 'drizzle-orm';
import { createZodDto } from 'nestjs-zod';
import { configurationOf } from './commands.js';
import { PrivacyService } from './privacy.service.js';
import { reachesRequest, requestOut } from './requests.js';

class ListQuery extends createZodDto(ListPrivacyRequestsQuery) {}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const notFound = () =>
  new NotFoundException({ error: 'not_found', message: 'No such privacy request' });

/**
 * Privacy requests as people read them: a person their own, the business's privacy team
 * (`privacy.manage`) every one of the business; anything else is 404. The register, for anyone
 * in the business; the business's own privacy settings, for its privacy team.
 */
@Controller('api/privacy')
@OptionalAuth()
@UseGuards(PrincipalGuard)
export class PrivacyController {
  private readonly db: Database;
  constructor(
    @Inject(CORE_OPTIONS) options: CoreOptions,
    private readonly privacy: PrivacyService,
  ) {
    this.db = options.db;
  }

  /** The team's note is the team's: its person reads the request without it. */
  private out(p: Principal, row: typeof privacyRequests.$inferSelect): PrivacyRequest {
    const value = requestOut(row);
    const shown = can(p, PrivacyManageCapability) ? value : { ...value, note: null };
    return projectRead(PRIVACY_REQUEST, shown, p) as PrivacyRequest;
  }

  @Get('requests')
  async list(
    @CurrentPrincipal() p: Principal,
    @Query() q: ListQuery,
  ): Promise<{ items: PrivacyRequest[] }> {
    const tenantId = tenantOf(p);
    if (p.actor.kind === 'agent') return { items: [] };
    // Parsed by the validation pipe: `mine` is a boolean here.
    const query = q as unknown as {
      status?: PrivacyRequest['status'];
      kind?: PrivacyRequest['kind'];
      mine?: boolean;
      limit?: number;
    };
    const subject = subjectOf(p);
    const all = can(p, PrivacyManageCapability) && !query.mine;
    if (!all && !subject) return { items: [] };
    const where = [
      eq(privacyRequests.tenantId, tenantId),
      query.status ? eq(privacyRequests.status, query.status) : undefined,
      query.kind ? eq(privacyRequests.kind, query.kind) : undefined,
      all || !subject
        ? undefined
        : and(
            eq(privacyRequests.subjectKind, subject.kind),
            eq(
              privacyRequests.subjectId,
              subject.kind === 'user' ? subject.userId : subject.contactId,
            ),
          ),
    ].filter((x): x is SQL => !!x);
    const rows = await this.db
      .select()
      .from(privacyRequests)
      .where(and(...where))
      .orderBy(desc(privacyRequests.receivedAt), desc(privacyRequests.id))
      .limit(query.limit ?? 50);
    return { items: rows.filter((r) => reachesRequest(p, r)).map((r) => this.out(p, r)) };
  }

  @Get('requests/:id')
  async get(@CurrentPrincipal() p: Principal, @Param('id') id: string): Promise<PrivacyRequest> {
    if (!UUID.test(id)) throw notFound();
    const [row] = await this.db
      .select()
      .from(privacyRequests)
      .where(and(eq(privacyRequests.id, id), eq(privacyRequests.tenantId, tenantOf(p))));
    if (!row || !reachesRequest(p, row)) throw notFound();
    return this.out(p, row);
  }

  /**
   * The business's own privacy settings, as `PATCH /api/privacy/settings` changes them: for its
   * privacy team (people only), read fresh, never from the cache.
   */
  @Get('settings')
  @UseGuards(HumanOnlyGuard)
  async settings(@CurrentPrincipal() p: Principal): Promise<PrivacyConfiguration> {
    requireCapability(p, PrivacyManageCapability, {
      rule: 'needs_privacy_manage',
      reason: 'Only someone who handles privacy requests can do this',
    });
    return configurationOf(await settingsIn(this.db, tenantOf(p)));
  }

  /** Who holds personal data here, what, for how long; `lang` picks the words (default en). */
  @Get('register')
  register(
    @CurrentPrincipal() p: Principal,
    @Query('lang') lang?: string,
  ): Promise<PrivacyRegister> {
    const l: Lang = LANGS.includes(lang as Lang) ? (lang as Lang) : 'en';
    return this.privacy.register(p, l);
  }
}
