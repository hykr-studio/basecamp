import {
  createInputOf,
  type ListQuery,
  listQuerySchema,
  type Principal,
  pathParams,
  type SummaryQuery,
  summaryQuerySchema,
} from '@hykr/contracts';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  type Type,
  UseGuards,
} from '@nestjs/common';
import { CommandBus, QueryBus } from '@nestjs/cqrs';
import { OptionalAuth } from '@thallesp/nestjs-better-auth';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import type { AnyCommandDef } from '../command/define-command.js';
import type { AnyEntityDef } from '../entity/define-entity.js';
import type { WriteCtx } from '../write/pipeline.js';
import { HonorsIfMatch } from './if-match.js';
import {
  CurrentPrincipal,
  HumanOnlyGuard,
  PrincipalGuard,
  RequestMeta,
  type RequestMetaValue,
  RequireScope,
  type RouteScope,
} from './principal.js';

const writeCtx = (p: Principal, meta: RequestMetaValue): WriteCtx => ({
  principal: p,
  requestId: meta.requestId,
  idempotencyKey: meta.idempotencyKey,
  ...(meta.ifMatch ? { ifMatch: meta.ifMatch } : {}),
});

type ParamDecorator = (target: object, key: string, index: number) => void;
interface Route {
  verb: (path?: string) => MethodDecorator;
  path: string;
  params: { decorator: ParamDecorator; type: unknown }[];
  status?: number;
  human: boolean;
  /** What a scoped credential needs here (its module's read or write scope). */
  scope: RouteScope;
  /** It checks the request's `If-Match` (an entity update or delete); every other route refuses one. */
  ifMatch?: boolean;
  // biome-ignore lint/suspicious/noExplicitAny: bound to the generated controller
  fn: (this: { commands: CommandBus; queries: QueryBus }, ...args: any[]) => unknown;
}

/** Applies Nest's decorators by hand, so actions that are not exposed get no route at all. */
function addRoute(proto: object, name: string, route: Route) {
  Object.defineProperty(proto, name, { value: route.fn, writable: true, configurable: true });
  const descriptor = Object.getOwnPropertyDescriptor(proto, name) as PropertyDescriptor;
  for (const [i, p] of route.params.entries()) p.decorator(proto, name, i);
  Reflect.defineMetadata(
    'design:paramtypes',
    route.params.map((p) => p.type),
    proto,
    name,
  );
  route.verb(route.path)(proto, name, descriptor);
  UseGuards(PrincipalGuard, ...(route.human ? [HumanOnlyGuard] : []))(proto, name, descriptor);
  RequireScope(route.scope)(proto, name, descriptor);
  if (route.ifMatch) HonorsIfMatch()(proto, name, descriptor);
  if (route.status) HttpCode(route.status)(proto, name, descriptor);
}

function controllerClass(name: string, prefix: string, routes: Record<string, Route>): Type {
  class GeneratedController {
    constructor(
      readonly commands: CommandBus,
      readonly queries: QueryBus,
    ) {}
  }
  Reflect.defineMetadata('design:paramtypes', [CommandBus, QueryBus], GeneratedController);
  for (const [method, route] of Object.entries(routes))
    addRoute(GeneratedController.prototype, method, route);
  OptionalAuth()(GeneratedController);
  Controller(prefix)(GeneratedController);
  Object.defineProperty(GeneratedController, 'name', { value: name });
  return GeneratedController;
}

const principal = { decorator: CurrentPrincipal() as ParamDecorator, type: Object };
const meta = { decorator: RequestMeta() as ParamDecorator, type: Object };
const idParam = { decorator: Param('id', ParseUUIDPipe) as ParamDecorator, type: String };

/**
 * GET/POST /api/<plural>, GET /api/<plural>/summary, GET/PATCH/DELETE /api/<plural>/:id — parsing
 * only, then the buses.
 */
export function entityController(def: AnyEntityDef): Type {
  const { spec, cqrs } = def;
  const ListDto = createZodDto(listQuerySchema(spec));
  const SummaryDto = createZodDto(summaryQuerySchema(spec));
  // With a client-chosen id when the entity takes them (B12).
  const CreateDto = createZodDto(createInputOf(spec));
  const UpdateDto = createZodDto(spec.schemas.update);
  const human = (action: keyof typeof spec.expose) => spec.expose[action] === 'human';
  // Read when the request is made: a spec may be stamped with its module after this runs.
  const module = () => spec.module;
  const read: RouteScope = { access: 'read', module };
  const write: RouteScope = { access: 'write', module };

  const all: Record<string, Route> = {
    list: {
      verb: Get,
      path: '',
      human: human('list'),
      scope: read,
      params: [principal, { decorator: Query() as ParamDecorator, type: ListDto }],
      fn(p: Principal, q: ListQuery) {
        return this.queries.execute(new cqrs.ListQuery(p, q));
      },
    },
    // Before ':id', so 'summary' is never taken for an id. A summary is a read of the list.
    summary: {
      verb: Get,
      path: 'summary',
      human: human('list'),
      scope: read,
      params: [principal, { decorator: Query() as ParamDecorator, type: SummaryDto }],
      fn(p: Principal, q: SummaryQuery) {
        return this.queries.execute(new cqrs.SummaryQuery(p, q));
      },
    },
    get: {
      verb: Get,
      path: ':id',
      human: human('get'),
      scope: read,
      params: [principal, idParam],
      fn(p: Principal, id: string) {
        return this.queries.execute(new cqrs.GetQuery(p, id));
      },
    },
    create: {
      verb: Post,
      path: '',
      human: human('create'),
      scope: write,
      params: [principal, { decorator: Body() as ParamDecorator, type: CreateDto }, meta],
      fn(p: Principal, body: unknown, m: RequestMetaValue) {
        return this.commands.execute(new cqrs.CreateCommand(writeCtx(p, m), body));
      },
    },
    update: {
      verb: Patch,
      path: ':id',
      human: human('update'),
      scope: write,
      ifMatch: true,
      params: [principal, idParam, { decorator: Body() as ParamDecorator, type: UpdateDto }, meta],
      fn(p: Principal, id: string, body: unknown, m: RequestMetaValue) {
        return this.commands.execute(new cqrs.UpdateCommand(writeCtx(p, m), id, body));
      },
    },
    delete: {
      verb: Delete,
      path: ':id',
      human: human('delete'),
      scope: write,
      ifMatch: true,
      params: [principal, idParam, meta],
      fn(p: Principal, id: string, m: RequestMetaValue) {
        return this.commands.execute(new cqrs.DeleteCommand(writeCtx(p, m), id));
      },
    },
  };
  // 'internal' actions get no route: only commands can call them. The summary goes with the list.
  const exposeOf = (route: string) =>
    (route === 'summary' ? 'list' : route) as keyof typeof spec.expose;
  const routes = Object.fromEntries(
    Object.entries(all).filter(([route]) => spec.expose[exposeOf(route)] !== 'internal'),
  );
  return controllerClass(`${def.pascal}Controller`, `api/${def.plural}`, routes);
}

const verbs = { POST: Post, PATCH: Patch, PUT: Put, DELETE: Delete } as const;

/** One route per command, e.g. POST /api/meetings/:meetingId/close. Path params join the input. */
export function commandController(def: AnyCommandDef): Type {
  const { spec } = def;
  const params = pathParams(spec.http.path);
  const shape = spec.input.shape as Record<string, z.ZodType>;
  const bodyShape = Object.fromEntries(Object.entries(shape).filter(([k]) => !params.includes(k)));
  // A request with no body (DELETE /api/x/:id) is an empty one: its fields' own rules decide.
  const BodyDto = createZodDto(z.preprocess((b) => b ?? {}, z.object(bodyShape)));
  const route: Route = {
    verb: verbs[spec.http.method as keyof typeof verbs],
    path: spec.http.path.replace(/^\/?api\//, ''),
    human: spec.expose === 'human',
    scope: { access: 'write', module: () => spec.module },
    status: 200,
    params: [
      principal,
      { decorator: Param() as ParamDecorator, type: Object },
      { decorator: Body() as ParamDecorator, type: BodyDto },
      meta,
    ],
    fn(
      p: Principal,
      pathValues: Record<string, string>,
      body: Record<string, unknown>,
      m: RequestMetaValue,
    ) {
      return this.commands.execute(new def.Command(writeCtx(p, m), { ...body, ...pathValues }));
    },
  };
  return controllerClass(`${def.Command.name.replace(/Command$/, '')}Controller`, 'api', {
    run: route,
  });
}
