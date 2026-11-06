import { entityController, entityHandlers } from '@hykr/core';
import { Module } from '@nestjs/common';
import { Order } from './order.entity.js';

@Module({
  controllers: [entityController(Order)],
  providers: [...entityHandlers(Order)],
})
export class OrdersModule {}
