import {
  ListPrivacyRequestsQuery,
  PRIVACY_REQUEST,
  type Principal,
  PrivacyManageCapability,
  type PrivacyRegister,
  type PrivacyRequest,
} from '@hykr/contracts';
import { CurrentPrincipal, PrincipalGuard, projectRead, tenantOf } from '@hykr/core';
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
import { DB } from '../../infra/db.module.js';
import { PrivacyService } from './privacy.service.js';
import { reachesRequest, requestOut } from './requests.js';

class ListQuery extends createZodDto(ListPrivacyRequestsQuery) {}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const notFound = () =>
  new NotFoundException({ error: 'not_found', message: 'No such privacy request' });

/**
 * Privacy requests as people read them: a person their own, the business's privacy team
 * (`privacy.manage`) every one of the business; anything else is 404. And the register, for
 * anyone in the business.
 */
@Controller('api/privacy')
@OptionalAuth()
@UseGuards(PrincipalGuard)
export class PrivacyController {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly privacy: PrivacyService,
  ) {}

  private out(p: Principal, row: typeof privacyRequests.$inferSelect): PrivacyRequest {
    return projectRead(PRIVACY_REQUEST, requestOut(row), p) as PrivacyRequest;
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
