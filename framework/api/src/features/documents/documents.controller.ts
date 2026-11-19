import type { DocumentInfo, DocumentKindInfo, Principal } from '@hykr/contracts';
import { CurrentPrincipal, PrincipalGuard } from '@hykr/core';
import {
  BadRequestException,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Query,
  UseGuards,
} from '@nestjs/common';
import { OptionalAuth } from '@thallesp/nestjs-better-auth';
import { DocumentsService } from './documents.service.js';

/**
 * Reading documents. Asking for one (`POST /api/documents`) and sending one
 * (`POST /api/documents/:documentId/send`) are commands, served by their own controllers. A
 * document is reached only through the record it is about, by someone who sees at least what
 * its requester saw; everything else is 404. The assistant reads them too, never with a URL.
 */
@Controller('api/documents')
@OptionalAuth()
@UseGuards(PrincipalGuard)
export class DocumentsController {
  constructor(private readonly documents: DocumentsService) {}

  /** The kinds of document an entity has (every kind when none is named). */
  @Get('kinds')
  kinds(@Query('entity') entity?: string): { items: DocumentKindInfo[] } {
    return { items: this.documents.kinds(entity || undefined) };
  }

  /** A record's documents the caller reaches, newest first. */
  @Get()
  async list(
    @CurrentPrincipal() p: Principal,
    @Query('entity') entity?: string,
    @Query('id') id?: string,
  ): Promise<{ items: DocumentInfo[] }> {
    if (!entity || !id)
      throw new BadRequestException({
        error: 'bad_query',
        message: 'Name the record: ?entity=<entity>&id=<id>',
      });
    return { items: await this.documents.list(p, entity, id) };
  }

  @Get(':id')
  get(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.documents.get(p, id);
  }
}
