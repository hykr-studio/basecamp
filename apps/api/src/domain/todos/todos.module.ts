import { entityController, entityHandlers } from '@app/core';
import { Module } from '@nestjs/common';
import { Todo } from './todo.entity.js';

@Module({ controllers: [entityController(Todo)], providers: [...entityHandlers(Todo)] })
export class TodosModule {}
