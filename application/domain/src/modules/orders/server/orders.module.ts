import { commandController, commandHandler, entityController, entityHandlers } from '@hykr/core';
import { Module } from '@nestjs/common';
import { Order, OrderItem } from './order.entity.js';
import { ReviseOrder } from './revise-order.command.js';
import { SaveOrder } from './save-order.command.js';

@Module({
  controllers: [
    // Before the entity's /api/orders/:id routes: /api/orders/save is the command's. Moving an
    // order (submit, approve, cancel) is the framework's POST /api/transitions/orders/:id/:name.
    commandController(SaveOrder),
    commandController(ReviseOrder),
    entityController(Order),
    entityController(OrderItem),
  ],
  providers: [
    ...entityHandlers(Order),
    ...entityHandlers(OrderItem),
    commandHandler(SaveOrder),
    commandHandler(ReviseOrder),
  ],
})
export class OrdersModule {}
