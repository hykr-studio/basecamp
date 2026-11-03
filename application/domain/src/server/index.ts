/**
 * THE DOMAIN's API: meetings, notes and to-dos, each declared once (defineEntity /
 * defineCommand) with the framework generating routes, handlers and audit. Replace this
 * folder to bring another domain; the app module imports only `DomainModule`.
 */
import { Module } from '@nestjs/common';
import { MeetingsModule } from './meetings/meetings.module.js';
import { NotesModule } from './notes/notes.module.js';
import { TodosModule } from './todos/todos.module.js';

@Module({ imports: [TodosModule, NotesModule, MeetingsModule] })
export class DomainModule {}
