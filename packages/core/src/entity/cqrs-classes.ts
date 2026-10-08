import type { ListQuery, Principal } from '@app/contracts';
import type { WriteCtx } from '../write/pipeline.js';

/**
 * Per-entity CQRS message classes. @nestjs/cqrs routes by class, so each entity gets its
 * own: ListMeetingsQuery, CreateMeetingCommand, MeetingCreated, and so on.
 */
export class EntityQuery {}
export class EntityCommand {}

export class EntityEvent implements NamedEvent {
  constructor(
    readonly entity: string,
    readonly change: 'created' | 'updated' | 'deleted',
    readonly row: unknown,
  ) {}
  get eventName() {
    return `${this.entity}.${this.change}`;
  }
}

/**
 * An event other parts of the system can react to without knowing its class: what happened
 * ("meeting.closed") and to which row. Entity events are; a command's events opt in (a
 * notification schedules on them, for one).
 */
export interface NamedEvent {
  readonly eventName: string;
  readonly row: unknown;
}

export const isNamedEvent = (e: unknown): e is NamedEvent =>
  typeof e === 'object' &&
  e !== null &&
  typeof (e as NamedEvent).eventName === 'string' &&
  'row' in (e as object);

function named<C>(cls: C, name: string): C {
  Object.defineProperty(cls, 'name', { value: name });
  return cls;
}

export function defineEntityCqrs(pascal: string, plural: string) {
  const Plural = plural[0].toUpperCase() + plural.slice(1);
  return {
    ListQuery: named(
      class extends EntityQuery {
        constructor(
          readonly principal: Principal,
          readonly query: ListQuery,
        ) {
          super();
        }
      },
      `List${Plural}Query`,
    ),
    GetQuery: named(
      class extends EntityQuery {
        constructor(
          readonly principal: Principal,
          readonly id: string,
        ) {
          super();
        }
      },
      `Get${pascal}Query`,
    ),
    CreateCommand: named(
      class extends EntityCommand {
        constructor(
          readonly ctx: WriteCtx,
          readonly input: unknown,
        ) {
          super();
        }
      },
      `Create${pascal}Command`,
    ),
    UpdateCommand: named(
      class extends EntityCommand {
        constructor(
          readonly ctx: WriteCtx,
          readonly id: string,
          readonly input: unknown,
        ) {
          super();
        }
      },
      `Update${pascal}Command`,
    ),
    DeleteCommand: named(
      class extends EntityCommand {
        constructor(
          readonly ctx: WriteCtx,
          readonly id: string,
        ) {
          super();
        }
      },
      `Delete${pascal}Command`,
    ),
    Created: named(class extends EntityEvent {}, `${pascal}Created`),
    Updated: named(class extends EntityEvent {}, `${pascal}Updated`),
    Deleted: named(class extends EntityEvent {}, `${pascal}Deleted`),
  };
}
export type EntityCqrs = ReturnType<typeof defineEntityCqrs>;
