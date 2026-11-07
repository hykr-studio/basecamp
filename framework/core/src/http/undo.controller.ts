import type { Principal } from '@hykr/contracts';
import {
  Controller,
  HttpCode,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { OptionalAuth } from '@thallesp/nestjs-better-auth';
import { UndoService } from '../write/undo.js';
import {
  CurrentPrincipal,
  HumanOnlyGuard,
  PrincipalGuard,
  RequestMeta,
  type RequestMetaValue,
} from './principal.js';

/**
 * Undo a write within its undo window: `POST /api/undo/:id`, with the `undo.id` a write's result
 * carried. People only, and only the person the write was for (anyone else: 404).
 */
@Controller('api/undo')
@OptionalAuth()
@UseGuards(PrincipalGuard, HumanOnlyGuard)
export class UndoController {
  constructor(@Inject(UndoService) private readonly undos: UndoService) {}

  @Post(':id')
  @HttpCode(200)
  undo(
    @CurrentPrincipal() p: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @RequestMeta() meta: RequestMetaValue,
  ) {
    return this.undos.undo(p, id, meta.requestId);
  }
}
