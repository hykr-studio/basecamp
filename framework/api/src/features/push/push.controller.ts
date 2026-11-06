import {
  ForgetPushToken,
  type Principal,
  type PushDevice,
  RegisterPushToken,
} from '@hykr/contracts';
import { CurrentPrincipal, HumanOnlyGuard, PrincipalGuard } from '@hykr/core';
import { Body, Controller, Get, HttpCode, Post, UseGuards } from '@nestjs/common';
import { AllowAnonymous, OptionalAuth } from '@thallesp/nestjs-better-auth';
import { createZodDto } from 'nestjs-zod';
import { PushService } from './push.service.js';

class RegisterBody extends createZodDto(RegisterPushToken) {}
class ForgetBody extends createZodDto(ForgetPushToken) {}

/** A person's devices for push, in the business they work in. People only, except forget. */
@Controller('api/push/tokens')
export class PushController {
  constructor(private readonly push: PushService) {}

  @Post()
  @OptionalAuth()
  @UseGuards(PrincipalGuard, HumanOnlyGuard)
  register(@CurrentPrincipal() p: Principal, @Body() body: RegisterBody): Promise<PushDevice> {
    return this.push.register(p, body);
  }

  @Get()
  @OptionalAuth()
  @UseGuards(PrincipalGuard, HumanOnlyGuard)
  devices(@CurrentPrincipal() p: Principal): Promise<PushDevice[]> {
    return this.push.devices(p);
  }

  /**
   * This device gets no more pushes. No session needed: the app forgets its token after
   * sign-out. Holding the token is the proof, and this can only stop pushes. 204 either way.
   */
  @Post('forget')
  @AllowAnonymous()
  @HttpCode(204)
  async forget(@Body() body: ForgetBody): Promise<void> {
    await this.push.forget(body.token);
  }
}
