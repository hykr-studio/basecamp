import { commandController, commandHandler, entityController, entityHandlers } from '@hykr/core';
import { Module } from '@nestjs/common';
import { CancelOrder } from './cancel-order.command.js';
import { Order, OrderItem } from './order.entity.js';
import { SaveOrder } from './save-order.command.js';

@Module({
  controllers: [
    // Before the entity's /api/orders/:id routes: /api/orders/save is the command's.
    commandController(SaveOrder),
    commandController(CancelOrder),
    entityController(Order),
    entityController(OrderItem),
  ],
  providers: [
    ...entityHandlers(Order),
    ...entityHandlers(OrderItem),
    commandHandler(SaveOrder),
    commandHandler(CancelOrder),
  ],
})
export class OrdersModule {}
