import {
  ForgetPushToken,
  type Principal,
  PushActive,
  type PushDevice,
  RegisterPushToken,
  type WebPushKey,
} from '@hykr/contracts';
import { CurrentPrincipal, HumanOnlyGuard, PrincipalGuard } from '@hykr/core';
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Post,
  UseGuards,
} from '@nestjs/common';
import { AllowAnonymous, OptionalAuth } from '@thallesp/nestjs-better-auth';
import type { z } from 'zod';
import { PushService } from './push.service.js';
import { WebPushService } from './web.service.js';

/** The body, or 400: the bodies are unions (a phone's token or a browser's subscription). */
function parse<S extends z.ZodType>(schema: S, body: unknown): z.infer<S> {
  const input = schema.safeParse(body ?? {});
  if (!input.success)
    throw new BadRequestException({ error: 'invalid', issues: input.error.issues });
  return input.data;
}

/**
 * A person's phones and browsers for push, in the business they work in. People only, except
 * forget.
 */
@Controller('api/push/tokens')
export class PushController {
  constructor(
    private readonly push: PushService,
    private readonly web: WebPushService,
  ) {}

  @Post()
  @OptionalAuth()
  @UseGuards(PrincipalGuard, HumanOnlyGuard)
  register(
    @CurrentPrincipal() p: Principal,
    @Body() body: unknown,
    @Headers('user-agent') userAgent?: string,
  ): Promise<PushDevice> {
    const input = parse(RegisterPushToken, body);
    if (input.platform === 'web') return this.web.register(p, input.subscription, userAgent);
    return this.push.register(p, input);
  }

  @Get()
  @OptionalAuth()
  @UseGuards(PrincipalGuard, HumanOnlyGuard)
  async devices(@CurrentPrincipal() p: Principal): Promise<PushDevice[]> {
    return [...(await this.push.devices(p)), ...(await this.web.list(p))];
  }

  /**
   * The person is using the app on this device or in this browser now: the next push goes here.
   * Only their own device in this business moves; anything else changes nothing. 204 either way.
   */
  @Post('active')
  @OptionalAuth()
  @UseGuards(PrincipalGuard, HumanOnlyGuard)
  @HttpCode(204)
  async active(@CurrentPrincipal() p: Principal, @Body() body: unknown): Promise<void> {
    const input = parse(PushActive, body);
    if ('endpoint' in input) await this.web.active(p, input.endpoint);
    else await this.push.active(p, input.token);
  }

  /**
   * This device or browser gets no more pushes. No session needed: the app forgets it at
   * sign-out. Holding the token (or the endpoint) is the proof, and this can only stop pushes.
   * 204 either way.
   */
  @Post('forget')
  @AllowAnonymous()
  @HttpCode(204)
  async forget(@Body() body: unknown): Promise<void> {
    const input = parse(ForgetPushToken, body);
    if ('endpoint' in input) await this.web.forget(input.endpoint);
    else await this.push.forget(input.token);
  }
}

/** Web push's public side: the key a browser subscribes with. Anyone may read it. */
@Controller('api/push/web')
export class WebPushController {
  constructor(private readonly web: WebPushService) {}

  @Get('key')
  @AllowAnonymous()
  key(): WebPushKey {
    return { publicKey: this.web.publicKey() };
  }
}
