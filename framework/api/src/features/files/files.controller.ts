import { type FileInfo, PresignFileInput, type Principal } from '@hykr/contracts';
import {
  CurrentPrincipal,
  HumanOnlyGuard,
  PrincipalGuard,
  RequestMeta,
  type RequestMetaValue,
} from '@hykr/core';
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { OptionalAuth } from '@thallesp/nestjs-better-auth';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { FilesService } from './files.service.js';

class PresignDto extends createZodDto(PresignFileInput) {}

const Ids = z.array(z.uuid()).max(100);

/**
 * Files over HTTP. Uploads are people's: presign (`POST /api/files`, for one entity's file
 * field), PUT the bytes to the URL it gives, then confirm; an unused upload can be discarded.
 * Reading (`GET /api/files/:id`, `GET /api/files?ids=`) and transcribing are open to the
 * assistant too, through the same reach: a file is reached only through the record it is on, or
 * as the caller's own upload. Everything else is 404.
 */
@Controller('api/files')
@OptionalAuth()
@UseGuards(PrincipalGuard)
export class FilesController {
  constructor(private readonly files: FilesService) {}

  @Post()
  @UseGuards(HumanOnlyGuard)
  presign(
    @CurrentPrincipal() p: Principal,
    @Body() body: PresignDto,
    @RequestMeta() meta: RequestMetaValue,
  ) {
    return this.files.presign(p, body as PresignFileInput, meta);
  }

  @Get()
  async list(
    @CurrentPrincipal() p: Principal,
    @Query('ids') ids?: string,
  ): Promise<{ items: FileInfo[] }> {
    const parsed = Ids.safeParse(
      (ids ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    );
    if (!parsed.success)
      throw new BadRequestException({ error: 'bad_ids', message: 'ids: up to 100 file ids' });
    return { items: await this.files.getMany(p, parsed.data) };
  }

  @Get(':id')
  get(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.files.get(p, id);
  }

  @Post(':id/confirm')
  @HttpCode(200)
  @UseGuards(HumanOnlyGuard)
  confirm(
    @CurrentPrincipal() p: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @RequestMeta() meta: RequestMetaValue,
  ) {
    return this.files.confirm(p, id, meta.requestId);
  }

  @Delete(':id')
  @HttpCode(204)
  @UseGuards(HumanOnlyGuard)
  async discard(
    @CurrentPrincipal() p: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @RequestMeta() meta: RequestMetaValue,
  ) {
    await this.files.discard(p, id, meta);
  }

  @Post(':id/transcribe')
  @HttpCode(200)
  transcribe(
    @CurrentPrincipal() p: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @RequestMeta() meta: RequestMetaValue,
  ) {
    return this.files.transcribe(p, id, meta.requestId);
  }
}
