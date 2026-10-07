import { CreateTodoInput, UpdateTodoInput } from '@app/contracts';
import { createZodDto } from 'nestjs-zod';

export class CreateTodoDto extends createZodDto(CreateTodoInput) {}
export class UpdateTodoDto extends createZodDto(UpdateTodoInput) {}
