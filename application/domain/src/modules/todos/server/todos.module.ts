import { commandController, commandHandler, entityController, entityHandlers } from '@hykr/core';
import { Module } from '@nestjs/common';
import { ClearDoneTodos } from './clear-done.command.js';
import { Todo } from './todo.entity.js';

@Module({
  controllers: [entityController(Todo), commandController(ClearDoneTodos)],
  providers: [...entityHandlers(Todo), commandHandler(ClearDoneTodos)],
})
export class TodosModule {}
