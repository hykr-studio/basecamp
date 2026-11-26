import { type Principal, RecallKind, RecallQuery, type RecallResult } from '@hykr/contracts';
import { CurrentPrincipal, PrincipalGuard } from '@hykr/core';
import {
  BadRequestException,
  Controller,
  Get,
  NotFoundException,
  Query,
  UseGuards,
} from '@nestjs/common';
import { OptionalAuth } from '@thallesp/nestjs-better-auth';
import { parseAbout, RecallService } from './recall.service.js';

/**
 * Semantic recall over what the caller may read: people and the assistant (`recall-memory`)
 * alike, each re-checked as themselves.
 */
@Controller('api/memory')
@OptionalAuth()
@UseGuards(PrincipalGuard)
export class RecallController {
  constructor(private readonly memory: RecallService) {}

  /**
   * `GET /api/memory/recall?q=…&about=<type>:<id>&limit=5&kinds=record,message`: the nearest
   * memories the caller may read now, best first. `about` keeps memory of one record, which the
   * caller must be able to read (404 otherwise).
   */
  @Get('recall')
  async recall(
    @CurrentPrincipal() p: Principal,
    @Query() query: Record<string, unknown>,
  ): Promise<RecallResult> {
    const parsed = RecallQuery.safeParse(query);
    if (!parsed.success)
      throw new BadRequestException({
        error: 'invalid_query',
        problems: parsed.error.issues.map((i) => `${i.path.join('.') || '(query)'}: ${i.message}`),
      });
    const { q, limit, kinds } = parsed.data;
    const about = parseAbout(parsed.data.about);
    if (about && !(await this.memory.canRead(p, about)))
      throw new NotFoundException({ error: 'not_found', message: `No such ${about.type}` });
    return this.memory.recall(p, {
      query: q,
      ...(about ? { about } : {}),
      ...(limit ? { limit } : {}),
      ...(kinds ? { kinds: kinds.split(',').map((k) => RecallKind.parse(k)) } : {}),
    });
  }
}
