import { type Principal, type SlaPage, SlaQuery, type SlaTimer } from '@hykr/contracts';
import {
  type AnyEntityDef,
  CORE_OPTIONS,
  type CoreOptions,
  CurrentPrincipal,
  entityDefs,
  listSlaTimers,
  PrincipalGuard,
  recordSlaTimers,
} from '@hykr/core';
import {
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Query,
  UseGuards,
} from '@nestjs/common';
import { OptionalAuth } from '@thallesp/nestjs-better-auth';
import { createZodDto } from 'nestjs-zod';

class SlaListQuery extends createZodDto(SlaQuery) {}

const byPlural = (plural: string): AnyEntityDef | undefined =>
  entityDefs().find((d) => d.plural === plural);

/**
 * SLA clocks, as the records they run on allow (docs/decisions/S3.md): a record's own (404 when
 * the caller cannot read it), and the business's in one status on records the caller reads (a
 * Today view), a keyset page at a time, with reach decided in SQL.
 */
@Controller('api/sla')
@OptionalAuth()
@UseGuards(PrincipalGuard)
export class SlaController {
  constructor(@Inject(CORE_OPTIONS) private readonly options: CoreOptions) {}

  @Get()
  list(@CurrentPrincipal() p: Principal, @Query() q: SlaListQuery): Promise<SlaPage> {
    return listSlaTimers(this.options.db, p, q);
  }

  @Get(':plural/:id')
  of(
    @CurrentPrincipal() p: Principal,
    @Param('plural') plural: string,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<SlaTimer[]> {
    const def = byPlural(plural);
    if (!def) throw new NotFoundException({ error: 'not_found', message: 'No such records' });
    return recordSlaTimers(this.options.db, p, def, id);
  }
}
