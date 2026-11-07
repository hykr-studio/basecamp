// The run log and the application's templates. The log is the agent's owner's and the business's
// managers'; anyone else, another business included, gets 404. An agent run's token reaches none.
import type { AgentRunDetail, AgentRunPage, AgentTemplates, Principal } from '@hykr/contracts';
import { CurrentPrincipal, PrincipalGuard } from '@hykr/core';
import { isLang } from '@hykr/i18n';
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
import { AgentRunsQueryParsed, AgentsService } from './agents.service.js';
import { allToolIds, unscoped } from './scope.js';

/** The tools a scope may hold, sorted. */
const scopeTools = () =>
  allToolIds()
    .filter((t) => !unscoped().has(t))
    .sort();

@Controller('api/agent-runs')
@OptionalAuth()
@UseGuards(PrincipalGuard)
export class AgentRunsController {
  constructor(private readonly agents: AgentsService) {}

  /** `GET /api/agent-runs?agentId&status&cursor&limit`: newest first. */
  @Get()
  async list(
    @CurrentPrincipal() p: Principal,
    @Query() query: Record<string, unknown>,
  ): Promise<AgentRunPage> {
    const parsed = AgentRunsQueryParsed.safeParse(query);
    if (!parsed.success)
      throw new BadRequestException({
        error: 'invalid_query',
        problems: parsed.error.issues.map((i) => `${i.path.join('.') || '(query)'}: ${i.message}`),
      });
    return this.agents.runs(p, parsed.data);
  }

  /** One run with its messages: what started it, what it said and did. */
  @Get(':id')
  async one(
    @CurrentPrincipal() p: Principal,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<AgentRunDetail> {
    return this.agents.run(p, id);
  }
}

@Controller('api/agent-templates')
@OptionalAuth()
@UseGuards(PrincipalGuard)
export class AgentTemplatesController {
  constructor(private readonly agents: AgentsService) {}

  /**
   * The application's ready-made agents, in the reader's language (`?lang=`), and every tool an
   * agent may be given here (the editor's choices).
   */
  @Get()
  list(@Query('lang') lang?: string): AgentTemplates {
    return {
      items: this.agents.templates(isLang(lang) ? lang : 'en'),
      tools: scopeTools(),
    };
  }
}
