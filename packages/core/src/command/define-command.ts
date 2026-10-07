import type { AuthorizeResult, CommandSpec, Principal } from '@app/contracts';
import { Inject, type Type } from '@nestjs/common';
import { CommandHandler, EventBus } from '@nestjs/cqrs';
import type { z } from 'zod';
import type { RuleContext } from '../entity/define-entity.js';
import { toJson } from '../entity/define-entity.js';
import { CORE_OPTIONS, type CoreOptions, type Tx } from '../tokens.js';
import { registerOp } from '../write/approvals.js';
import { type RunResult, runWrite, type WriteCtx, type WriteOp } from '../write/pipeline.js';

export interface CommandConfig<S extends CommandSpec, L, V> {
  /** What the rules need, loaded through entity repositories (owner-scoped: 404 if not theirs). */
  load?: (tx: Tx, p: Principal, input: z.output<S['input']>) => Promise<L>;
  authorize: (p: Principal, loaded: L, input: z.output<S['input']>) => AuthorizeResult;
  /** What the approval card says when this is parked. */
  summarize: (input: z.output<S['input']>, loaded: L) => string;
  /** The row the command is about, for the audit trail and the approval. */
  resource: { type: string; id: (input: z.output<S['input']>, loaded: L) => string | null };
  /**
   * The work, inside the write path's transaction. Pass `via` to entity repositories so
   * entity rules know which command is calling.
   */
  run: (a: {
    tx: Tx;
    principal: Principal;
    input: z.output<S['input']>;
    loaded: L;
    via: RuleContext;
  }) => Promise<RunResult<V>>;
}

export class AppCommand {
  constructor(
    readonly ctx: WriteCtx,
    readonly input: unknown,
  ) {}
}

export interface CommandDef<S extends CommandSpec = CommandSpec, L = unknown, V = unknown> {
  kind: 'command';
  spec: S;
  name: string;
  Command: Type<AppCommand>;
  op(): WriteOp<z.output<S['input']>, L, V>;
}
// biome-ignore lint/suspicious/noExplicitAny: a registry of heterogeneous commands
export type AnyCommandDef = CommandDef<any, any, any>;

/** meeting.close → MeetingCloseCommand */
const pascalOf = (name: string) =>
  name
    .split(/[.\-_]/)
    .map((s) => s[0].toUpperCase() + s.slice(1))
    .join('');

export function defineCommand<S extends CommandSpec, L, V>(
  spec: S,
  config: CommandConfig<S, L, V>,
): CommandDef<S, L, V> {
  const Command = class extends AppCommand {};
  Object.defineProperty(Command, 'name', { value: `${pascalOf(spec.name)}Command` });
  const via: RuleContext = { via: spec.name };
  return {
    kind: 'command',
    spec,
    name: spec.name,
    Command,
    op: () => ({
      name: spec.name,
      kind: 'command',
      resourceType: config.resource.type,
      resourceId: config.resource.id,
      input: spec.input as unknown as z.ZodType<z.output<S['input']>>,
      load: config.load,
      authorize: config.authorize,
      summarize: config.summarize,
      run: (a) => config.run({ ...a, via }),
      present: (value) => spec.output.parse(toJson(value)),
    }),
  };
}

/** The CQRS handler for one command: it calls runWrite and publishes events after commit. */
export function commandHandler(def: AnyCommandDef): Type {
  registerOp(def.name, () => def.op());

  @CommandHandler(def.Command)
  class Handler {
    constructor(
      @Inject(CORE_OPTIONS) private readonly options: CoreOptions,
      @Inject(EventBus) private readonly events: EventBus,
    ) {}
    async execute(cmd: AppCommand) {
      const { result, events } = await runWrite(this.options.db, cmd.ctx, def.op(), cmd.input);
      for (const event of events) this.events.publish(event);
      return result;
    }
  }
  Object.defineProperty(Handler, 'name', { value: `${def.Command.name}Handler` });
  return Handler;
}
