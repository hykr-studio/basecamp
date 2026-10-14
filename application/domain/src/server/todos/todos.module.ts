import { entityController, entityHandlers } from '@hykr/core';
import { Module } from '@nestjs/common';
import { Todo } from './todo.entity.js';

@Module({ controllers: [entityController(Todo)], providers: [...entityHandlers(Todo)] })
export class TodosModule {}
