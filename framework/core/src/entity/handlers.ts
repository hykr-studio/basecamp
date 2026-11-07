import {
  createInputOf,
  type IfMatch,
  IfMatchError,
  ifMatchHolds,
  type Page,
  type Principal,
  parseIfMatch,
  type Summary,
  versionedOf,
  type WriteAction,
} from '@hykr/contracts';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  type Type,
} from '@nestjs/common';
import { CommandHandler, EventBus, QueryHandler } from '@nestjs/cqrs';
import { z } from 'zod';
import { summarize } from '../query/aggregate.js';
import { CORE_OPTIONS, type CoreOptions } from '../tokens.js';
import { checkPins, type Pins, pinsOf, versionNote } from '../versions/pins.js';
import { registerOp } from '../write/approvals.js';
import { runWrite, type WriteCtx, type WriteOp } from '../write/pipeline.js';
import type { AnyEntityDef } from './define-entity.js';
import { registerEntityDef } from './registry.js';

type Row = Record<string, unknown> & { id: string };

/** The 400 for an `If-Match` the server cannot check: never ignored. */
const unsupported = (reason: string) =>
  new BadRequestException({ error: 'if_match_unsupported', reason });

/**
 * A request's `If-Match` for an entity write, read and checked against what the entity can
 * honour: versions need a versioned entity (B4), and only an update or a delete takes one.
 */
export function ifMatchFor(
  def: AnyEntityDef,
  action: WriteAction,
  header: string | undefined,
): IfMatch | undefined {
  let want: IfMatch | undefined;
  try {
    want = parseIfMatch(header);
  } catch (e) {
    if (e instanceof IfMatchError) throw unsupported(e.message);
    throw e;
  }
  if (!want) return undefined;
  if (action === 'create') throw unsupported('A new record has no version to match');
  if ('versions' in want && !versionedOf(def.spec))
    throw unsupported(`A ${def.spec.label} has no version to match: send If-Match: * or none`);
  return want;
}

/**
 * The write op for one CRUD action: the same shape a hand-written command builds. An update or
 * delete pins the record it loads (its plugins' `onPark`, a version) in its `args`, which a park
 * stores: the approved replay gets them back and refuses (409) if the record moved on since.
 * With `ifMatch` (the request's If-Match, B12) the record it loads must have one of those
 * versions, or it refuses (409 `stale`) before anything runs; the update or delete is then
 * conditional on that version (the versioned plugin's `updateWhere`).
 */
export function entityOp(
  def: AnyEntityDef,
  action: WriteAction,
  args: { id?: string; pins?: Pins; ifMatch?: IfMatch } | null,
): WriteOp<Record<string, unknown>, Row | null, Row> {
  const { spec, repo } = def;
  const id = args?.id;
  const ifMatch = args?.ifMatch;
  // On a replay, what the request pinned; otherwise what load pins now (read when it parks).
  const pinned = args?.pins;
  let pins = pinned;
  const schema =
    action === 'create'
      ? createInputOf(spec)
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
    // A create names the id it makes when the client chose one (B12), so a parked create does too.
    resourceId: (input, loaded) =>
      loaded?.id ?? (action === 'create' && typeof input.id === 'string' ? input.id : null),
    input: schema as z.ZodType<Record<string, unknown>>,
    get args() {
      return id ? { id, ...(pins ? { pins } : {}), ...(ifMatch ? { ifMatch } : {}) } : undefined;
    },
    approval: def.spec.approval[action],
    load: id
      ? async (tx, p) => {
          const row = (await repo.get(tx, p, id)) as Row;
          if (ifMatch && !ifMatchHolds(spec, row, ifMatch))
            throw new ConflictException({
              error: 'stale',
              message: `This ${spec.label} changed since it was read. Load it again and retry.`,
            });
          if (pinned) checkPins([{ def, row }], pinned);
          else pins = pinsOf([{ def, row }]);
          return row;
        }
      : undefined,
    authorize: (p, loaded, input) =>
      def.decide(p, action, loaded, action === 'delete' ? null : input),
    summarize: (input, loaded) => {
      const said = def.summarize(action, action === 'delete' ? null : input, loaded);
      const version = versionNote(def, loaded);
      return version ? `${said} (${version})` : said;
    },
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
        events: def.events ? [new Event(def.name, change, row, loaded ?? undefined)] : [],
      };
    },
    present: (row, p) => (action === 'delete' ? null : def.toRead(row, p)),
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

/**
 * The CQRS handlers for one entity: list, summary, get, create, update and delete. List them in
 * the business module's providers. This serves the entity: it joins `entityDefs()` and its
 * writes can be replayed after approval.
 */
export function entityHandlers(def: AnyEntityDef): Type[] {
  const { cqrs } = def;
  registerEntityDef(def);
  for (const action of ['create', 'update', 'delete'] as const) {
    registerOp(
      `${def.name}.${action}`,
      (args) => entityOp(def, action, args as Parameters<typeof entityOp>[2]),
      def,
    );
  }

  @QueryHandler(cqrs.ListQuery)
  class ListHandler {
    constructor(@Inject(CORE_OPTIONS) private readonly options: CoreOptions) {}
    async execute(q: InstanceType<typeof cqrs.ListQuery>): Promise<Page<unknown>> {
      assertExposed(def, 'list', q.principal);
      // Plugins may refuse the request itself (a filter on a field this person cannot see).
      for (const x of def.plugins())
        x.query?.(q.query, q.principal, { spec: def.spec, table: def.table });
      const page = await def.repo.list(this.options.db, q.principal, q.query);
      return { ...page, items: page.items.map((row) => def.toRead(row, q.principal)) };
    }
  }

  @QueryHandler(cqrs.SummaryQuery)
  class SummaryHandler {
    constructor(@Inject(CORE_OPTIONS) private readonly options: CoreOptions) {}
    async execute(q: InstanceType<typeof cqrs.SummaryQuery>): Promise<Summary> {
      // A summary is a read of the list: the same exposure, scope and filters.
      assertExposed(def, 'list', q.principal);
      return summarize(this.options.db, def, q.principal, q.query);
    }
  }

  @QueryHandler(cqrs.GetQuery)
  class GetHandler {
    constructor(@Inject(CORE_OPTIONS) private readonly options: CoreOptions) {}
    async execute(q: InstanceType<typeof cqrs.GetQuery>) {
      assertExposed(def, 'get', q.principal);
      return def.toRead(await def.repo.get(this.options.db, q.principal, q.id), q.principal);
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
        const ifMatch = ifMatchFor(def, action, cmd.ctx.ifMatch);
        const op = entityOp(def, action, id ? { id, ...(ifMatch ? { ifMatch } : {}) } : null);
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
  Object.defineProperty(SummaryHandler, 'name', { value: `${cqrs.SummaryQuery.name}Handler` });
  return [
    ListHandler,
    SummaryHandler,
    GetHandler,
    writeHandler(cqrs.CreateCommand, 'create', () => undefined),
    writeHandler(cqrs.UpdateCommand, 'update', (c) => c.id),
    writeHandler(cqrs.DeleteCommand, 'delete', (c) => c.id),
  ];
}
