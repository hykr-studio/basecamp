import { ListCommentsQuery, MentionableQuery, type Principal } from '@hykr/contracts';
import { CurrentPrincipal, PrincipalGuard } from '@hykr/core';
import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { OptionalAuth } from '@thallesp/nestjs-better-auth';
import { createZodDto } from 'nestjs-zod';
import type { z } from 'zod';
import { CommentsService } from './comments.service.js';

class ListDto extends createZodDto(ListCommentsQuery) {}
class MentionableDto extends createZodDto(MentionableQuery) {}

/**
 * Reading comments: one record's, and who a comment there may name. Open to the assistant too,
 * acting for its person. A record the caller cannot read is 404. Writing is the comment
 * commands' (POST /api/comments, PATCH and DELETE /api/comments/:commentId).
 */
@Controller('api/comments')
@OptionalAuth()
@UseGuards(PrincipalGuard)
export class CommentsController {
  constructor(private readonly comments: CommentsService) {}

  @Get()
  list(@CurrentPrincipal() p: Principal, @Query() q: ListDto) {
    return this.comments.list(p, q as unknown as z.output<typeof ListCommentsQuery>);
  }

  @Get('mentionable')
  mentionable(@CurrentPrincipal() p: Principal, @Query() q: MentionableDto) {
    return this.comments.mentionable(p, q as unknown as z.output<typeof MentionableQuery>);
  }
}
