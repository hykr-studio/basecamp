import { entityController, entityHandlers } from '@hykr/core';
import { Module } from '@nestjs/common';
import { Brief } from './brief.entity.js';

@Module({
  controllers: [entityController(Brief)],
  providers: [...entityHandlers(Brief)],
})
export class BriefsModule {}
