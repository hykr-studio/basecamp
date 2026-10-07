import type { Page, Principal, WriteAction } from '@app/contracts';
import { ForbiddenException, Inject, type Type } from '@nestjs/common';
import { CommandHandler, EventBus, QueryHandler } from '@nestjs/cqrs';
import { z } from 'zod';
import { CORE_OPTIONS, type CoreOptions } from '../tokens.js';
import { registerOp } from '../write/approvals.js';
import { runWrite, type WriteCtx, type WriteOp } from '../write/pipeline.js';
import type { AnyEntityDef } from './define-entity.js';

type Row = Record<string, unknown> & { id: string };

/** The write op for one CRUD action: the same shape a hand-written command builds. */
export function entityOp(
  def: AnyEntityDef,
  action: WriteAction,
  args: { id?: string } | null,
): WriteOp<Record<string, unknown>, Row | null, Row> {
  const { spec, repo } = def;
  const id = args?.id;
  const schema =
    action === 'create'
      ? spec.schemas.create
      : action === 'update'
        ? spec.schemas.update
        : z.object({}).strict();
  const touch = (change: 'created' | 'updated' | 'deleted', row: Row, before?: Row | null) => ({
    type: def.name,
    id: row.id,
    change,
    before: before ?? undefined,
    after: change === 'deleted' ? undefined : row,
  });
  const Event = { create: def.cqrs.Created, update: def.cqrs.Updated, delete: def.cqrs.Deleted }[
    action
  ];
  const change = ({ create: 'created', update: 'updated', delete: 'deleted' } as const)[action];

  return {
    name: `${def.name}.${action}`,
    kind: 'entity',
    resourceType: def.name,
    resourceId: (_input, loaded) => loaded?.id ?? null,
    input: schema as z.ZodType<Record<string, unknown>>,
    args: id ? { id } : undefined,
    load: id ? (tx, p) => repo.get(tx, p, id) as Promise<Row> : undefined,
    authorize: (p, loaded, input) =>
      def.decide(p, action, loaded, action === 'delete' ? null : input),
    summarize: (input, loaded) => def.summarize(action, action === 'delete' ? null : input, loaded),
    async run({ tx, principal, input, loaded }) {
      const row = (
        action === 'create'
          ? await repo.insert(tx, principal, input)
          : action === 'update'
            ? await repo.update(tx, principal, loaded, input)
            : await repo.delete(tx, principal, loaded)
      ) as Row;
      return {
        value: row,
        touched: [touch(change, row, loaded)],
        events: def.events ? [new Event(def.name, change, row)] : [],
      };
    },
    present: (row) => (action === 'delete' ? null : def.toRead(row)),
  };
}

function assertExposed(def: AnyEntityDef, action: 'list' | 'get', p: Principal) {
  if (p.actor.kind === 'agent' && def.spec.expose[action] !== 'all') {
    throw new ForbiddenException({
      error: 'forbidden',
      rule: 'humans_only',
      reason: `Only people can ${action} ${def.plural}`,
    });
  }
}

/** The five CQRS handlers for one entity. List them in the business module's providers. */
export function entityHandlers(def: AnyEntityDef): Type[] {
  const { cqrs } = def;
  for (const action of ['create', 'update', 'delete'] as const) {
    registerOp(`${def.name}.${action}`, (args) =>
      entityOp(def, action, args as { id?: string } | null),
    );
  }

  @QueryHandler(cqrs.ListQuery)
  class ListHandler {
    constructor(@Inject(CORE_OPTIONS) private readonly options: CoreOptions) {}
    async execute(q: InstanceType<typeof cqrs.ListQuery>): Promise<Page<unknown>> {
      assertExposed(def, 'list', q.principal);
      const page = await def.repo.list(this.options.db, q.principal, q.query);
      return { ...page, items: page.items.map((row) => def.toRead(row)) };
    }
  }

  @QueryHandler(cqrs.GetQuery)
  class GetHandler {
    constructor(@Inject(CORE_OPTIONS) private readonly options: CoreOptions) {}
    async execute(q: InstanceType<typeof cqrs.GetQuery>) {
      assertExposed(def, 'get', q.principal);
      return def.toRead(await def.repo.get(this.options.db, q.principal, q.id));
    }
  }

  const writeHandler = (
    Command: Type,
    action: WriteAction,
    idOf: (c: { id?: string }) => string | undefined,
  ) => {
    @CommandHandler(Command)
    class WriteHandler {
      constructor(
        @Inject(CORE_OPTIONS) private readonly options: CoreOptions,
        @Inject(EventBus) private readonly events: EventBus,
      ) {}
      async execute(cmd: { ctx: WriteCtx; id?: string; input?: unknown }) {
        const id = idOf(cmd);
        const op = entityOp(def, action, id ? { id } : null);
        const { result, events } = await runWrite(this.options.db, cmd.ctx, op, cmd.input ?? {});
        // After commit: a handler that runs early or fails can never see an uncommitted write.
        for (const event of events) this.events.publish(event);
        return result;
      }
    }
    Object.defineProperty(WriteHandler, 'name', { value: `${Command.name}Handler` });
    return WriteHandler;
  };

  Object.defineProperty(ListHandler, 'name', { value: `${cqrs.ListQuery.name}Handler` });
  Object.defineProperty(GetHandler, 'name', { value: `${cqrs.GetQuery.name}Handler` });
  return [
    ListHandler,
    GetHandler,
    writeHandler(cqrs.CreateCommand, 'create', () => undefined),
    writeHandler(cqrs.UpdateCommand, 'update', (c) => c.id),
    writeHandler(cqrs.DeleteCommand, 'delete', (c) => c.id),
  ];
}
