import { modelRegistry, policyProblems } from '@hykr/agents';
import type { ModelsOverview, Principal } from '@hykr/contracts';
import {
  CORE_OPTIONS,
  type CoreOptions,
  CurrentPrincipal,
  HumanOnlyGuard,
  PrincipalGuard,
  RequestMeta,
  type RequestMetaValue,
  runWrite,
} from '@hykr/core';
import { BadRequestException, Body, Controller, Get, Inject, Put, UseGuards } from '@nestjs/common';
import { EventBus } from '@nestjs/cqrs';
import { OptionalAuth } from '@thallesp/nestjs-better-auth';
import { ModelPolicyService } from './model-policy.service.js';
import { ModelPolicyInput, setModelPolicy } from './set-policy.js';

/**
 * The business's model policy: what it may use (any member) and setting it (`models.manage`,
 * signed in). People only: the assistant never reads or changes its own models.
 */
@Controller('api/models')
@OptionalAuth()
@UseGuards(PrincipalGuard, HumanOnlyGuard)
export class ModelsController {
  constructor(
    @Inject(CORE_OPTIONS) private readonly core: CoreOptions,
    @Inject(EventBus) private readonly events: EventBus,
    private readonly models: ModelPolicyService,
  ) {}

  @Get()
  overview(@CurrentPrincipal() p: Principal): Promise<ModelsOverview> {
    return this.models.overview(p);
  }

  /**
   * Replace the policy. A policy naming models the deployment does not have, or one whose chat
   * or embedding model it would itself refuse, is a 400 with every problem.
   */
  @Put('policy')
  async set(
    @CurrentPrincipal() p: Principal,
    @RequestMeta() meta: RequestMetaValue,
    @Body() body: unknown,
  ) {
    const parsed = ModelPolicyInput.safeParse(body ?? {});
    if (!parsed.success)
      throw new BadRequestException({
        error: 'invalid_policy',
        problems: parsed.error.issues.map((i) => `${i.path.join('.') || '(body)'}: ${i.message}`),
      });
    const problems = policyProblems(modelRegistry(), parsed.data);
    if (problems.length) throw new BadRequestException({ error: 'invalid_policy', problems });
    const { result, events } = await runWrite(
      this.core.db,
      { principal: p, requestId: meta.requestId, idempotencyKey: meta.idempotencyKey },
      setModelPolicy(),
      parsed.data,
    );
    for (const event of events) this.events.publish(event);
    return result;
  }
}
