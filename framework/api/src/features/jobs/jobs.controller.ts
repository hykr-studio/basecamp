import type { JobInfo, Principal } from '@hykr/contracts';
import {
  CurrentPrincipal,
  HumanOnlyGuard,
  PrincipalGuard,
  RequestMeta,
  type RequestMetaValue,
} from '@hykr/core';
import { Controller, Get, HttpCode, Param, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { AllowAnonymous, OptionalAuth } from '@thallesp/nestjs-better-auth';
import type { Request, Response } from 'express';
import { JobRunner } from './runner.service.js';

/**
 * Jobs over HTTP: a record's jobs, the caller's own, one job, and cancelling (people only). A job
 * is reached through the record it is about, or as the caller's own; everything else is 404.
 * Jobs are started by the application's own commands (`startJob`), never here.
 */
@Controller('api/jobs')
@OptionalAuth()
@UseGuards(PrincipalGuard)
export class JobsController {
  constructor(private readonly runner: JobRunner) {}

  @Get()
  async list(
    @CurrentPrincipal() p: Principal,
    @Query() query: Record<string, string>,
  ): Promise<{ items: JobInfo[] }> {
    return { items: await this.runner.list(p, query) };
  }

  @Get(':id')
  get(@CurrentPrincipal() p: Principal, @Param('id') id: string) {
    return this.runner.get(p, id);
  }

  @Post(':id/cancel')
  @HttpCode(200)
  @UseGuards(HumanOnlyGuard)
  cancel(
    @CurrentPrincipal() p: Principal,
    @Param('id') id: string,
    @RequestMeta() meta: RequestMetaValue,
  ) {
    return this.runner.cancel(p, id, meta);
  }
}

/**
 * Where a job's service posts its updates: no session (the signature, with the job's own
 * secret, is the right), no throttle (a service may report often). Verify, keep once, queue,
 * answer: the work happens in the worker.
 */
@Controller('api/jobs')
@AllowAnonymous()
@SkipThrottle()
export class JobCallbackController {
  constructor(private readonly runner: JobRunner) {}

  @Post(':id/callback')
  async receive(
    @Param('id') id: string,
    @Req() req: Request & { rawBody?: Buffer },
    @Res() res: Response,
  ) {
    const answer = await this.runner.receive(id, {
      rawBody: req.rawBody,
      headers: req.headers,
      body: req.body,
    });
    res.status(answer.status).json(answer.body);
  }
}
