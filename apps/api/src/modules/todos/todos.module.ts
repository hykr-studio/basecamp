import { Module } from '@nestjs/common';
import { ApprovalsController } from './approvals.controller.js';
import { TodosController } from './todos.controller.js';
import { TodosService } from './todos.service.js';

@Module({
  controllers: [TodosController, ApprovalsController],
  providers: [TodosService],
})
export class TodosModule {}
