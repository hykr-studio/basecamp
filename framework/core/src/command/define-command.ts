import type { ApproverRule, AuthorizeResult, CommandSpec, Principal } from '@hykr/contracts';
import { Inject, type Type } from '@nestjs/common';
import { CommandHandler, EventBus } from '@nestjs/cqrs';
import type { z } from 'zod';
import type { RuleContext } from '../entity/define-entity.js';
import { CORE_OPTIONS, type CoreOptions, type Tx } from '../tokens.js';
import { registerOp } from '../write/approvals.js';
import { checkPins, type PinTarget, type Pins, pinsOf } from '../versions/pins.js';
import { type RunResult, runWrite, type WriteCtx, type WriteOp } from '../write/pipeline.js';
import { presentOutput } from '../write/present.js';

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
  /**
   * Who decides it when authorize parks it: by role, on which channels, how surely. Default:
   * the person it is for (a customer's request: the business's owner and ops).
   */
  approval?: ApproverRule;
  /**
   * The result as this principal may see it. Default: the output schema parses it, each part
   * that reuses an entity's read schema is projected as that entity, then the read projectors
   * run with the command's name. Give this when the output hides an entity in a union or a
   * new schema (`.extend()`), so its fields are projected too.
   */
  present?: (value: V, p: Principal) => unknown;
  /**
   * The records `load` loaded that an approval must find unchanged (each one's plugins say how:
   * a version). When the command parks, their pins are kept with it; the approved replay loads
   * them again and refuses (409) if one moved on. Give it for a command that can park and
   * changes a versioned record.
   */
  pin?: (loaded: L, input: z.output<S['input']>) => readonly PinTarget[];
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
  /** Its write op; `args` are what a parked one stored (its pins), handed back on the replay. */
  op(args?: Record<string, unknown> | null): WriteOp<z.output<S['input']>, L, V>;
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
    op: (args) => {
      // On a replay, what the request pinned; otherwise what load pins now (read when it parks).
      const pinned = (args as { pins?: Pins } | null | undefined)?.pins;
      let pins = pinned;
      const pin = config.pin;
      const load = config.load;
      return {
      name: spec.name,
      kind: 'command',
      resourceType: config.resource.type,
      resourceId: config.resource.id,
      input: spec.input as unknown as z.ZodType<z.output<S['input']>>,
      get args() {
        return pins ? { pins } : undefined;
      },
      load:
        load && pin
          ? async (tx, p, input) => {
              const loaded = await load(tx, p, input);
              const targets = pin(loaded, input);
              if (pinned) checkPins(targets, pinned);
              else pins = pinsOf(targets);
              return loaded;
            }
          : load,
      authorize: config.authorize,
      summarize: config.summarize,
      approval: config.approval,
      run: (a) => config.run({ ...a, via }),
      present: (value, p) =>
        config.present ? config.present(value, p) : presentOutput(spec.output, value, p, spec.name),
      };
    },
  };
}

/** The CQRS handler for one command: it calls runWrite and publishes events after commit. */
export function commandHandler(def: AnyCommandDef): Type {
  registerOp(def.name, (args) => def.op(args), def);

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
