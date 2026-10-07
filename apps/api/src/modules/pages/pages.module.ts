import { entityController, entityHandlers } from '@app/core';
import { Module } from '@nestjs/common';
import { Page } from './page.entity.js';

@Module({ controllers: [entityController(Page)], providers: [...entityHandlers(Page)] })
export class PagesModule {}
