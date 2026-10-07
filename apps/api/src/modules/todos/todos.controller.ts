import type { Principal } from '@app/contracts';
import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { OptionalAuth } from '@thallesp/nestjs-better-auth';
import { IdempotencyInterceptor } from '../../common/idempotency.interceptor.js';
import { CurrentPrincipal, PrincipalGuard, RequestMeta } from '../../common/principal.js';
import { CreateTodoDto, UpdateTodoDto } from './dto.js';
import { TodosService } from './todos.service.js';

/** People and the agent. */
@Controller('api/todos')
@OptionalAuth()
@UseGuards(PrincipalGuard)
@UseInterceptors(IdempotencyInterceptor)
export class TodosController {
  constructor(private readonly todos: TodosService) {}

  @Get()
  list(@CurrentPrincipal() p: Principal, @RequestMeta() meta: RequestMeta) {
    return this.todos.list(p, meta);
  }

  @Post()
  create(
    @CurrentPrincipal() p: Principal,
    @Body() body: CreateTodoDto,
    @RequestMeta() meta: RequestMeta,
  ) {
    return this.todos.create(p, body, meta);
  }

  @Patch(':id')
  update(
    @CurrentPrincipal() p: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateTodoDto,
    @RequestMeta() meta: RequestMeta,
  ) {
    return this.todos.update(p, id, body, meta);
  }

  /** The agent gets needs_approval: a person has to confirm the delete. */
  @Delete(':id')
  remove(
    @CurrentPrincipal() p: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @RequestMeta() meta: RequestMeta,
  ) {
    return this.todos.remove(p, id, meta);
  }
}
