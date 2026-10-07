import { entityController, entityHandlers } from '@app/core';
import { Module } from '@nestjs/common';
import { Note } from './note.entity.js';

@Module({ controllers: [entityController(Note)], providers: [...entityHandlers(Note)] })
export class NotesModule {}
