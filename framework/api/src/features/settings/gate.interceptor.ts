// One interceptor on every route (A11), after the principal is known and before the handler:
// a route of a switched-off entity or command answers 404, and a list filter on a custom field
// the business has not defined as filterable answers 400.
import { type Catalog, type EntitySpec, listQuerySchema } from '@hykr/contracts';
import {
  type ApiRequest,
  CORE_OPTIONS,
  type CoreOptions,
  customFieldsOf,
  hasCustomFields,
} from '@hykr/core';
import {
  BadRequestException,
  type CallHandler,
  ConflictException,
  type ExecutionContext,
  Inject,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import { catchError, from, type Observable, switchMap, throwError } from 'rxjs';
import { runtime } from '../../runtime.js';
import { commandOff, entityOff, FeatureGates, switchedOff } from './gates.js';

type RouteTarget =
  | { kind: 'entity'; spec: EntitySpec; list: boolean }
  | { kind: 'command'; name: string };

let routes: { of: Catalog; byRoute: Map<string, RouteTarget> } | undefined;

const norm = (path: string) => `/${path.replace(/^\/+|\/+$/g, '')}`;

/** The catalog's routes: `GET /api/todos` → the to-do's list, `POST /api/x/:id/y` → a command. */
function routeTargets(catalog: Catalog): Map<string, RouteTarget> {
  if (routes?.of === catalog) return routes.byRoute;
  const byRoute = new Map<string, RouteTarget>();
  for (const spec of Object.values(catalog.entities)) {
    const base = `/api/${spec.plural}`;
    byRoute.set(`GET ${base}`, { kind: 'entity', spec, list: true });
    byRoute.set(`POST ${base}`, { kind: 'entity', spec, list: false });
    for (const verb of ['GET', 'PATCH', 'DELETE'])
      byRoute.set(`${verb} ${base}/:id`, { kind: 'entity', spec, list: false });
  }
  for (const spec of catalog.commands)
    byRoute.set(`${spec.http.method} ${norm(spec.http.path)}`, {
      kind: 'command',
      name: spec.name,
    });
  routes = { of: catalog, byRoute };
  return byRoute;
}

/** Unique indexes of the framework's own tables, by name. */
const CONFLICTS: Record<string, string> = {
  custom_fields_tenant_entity_key_idx: 'This entity already has a custom field with that key',
  tenant_domains_verified_origin_idx: 'Another business has verified this address',
  tenant_domains_tenant_origin_idx: 'This address is already registered',
};

/**
 * A unique index the database refused, as the 409 it means: a custom field's key used twice, or
 * a shared record overridden twice (the shared table's unique (tenant_id, shared_id) index).
 */
function asConflict(e: { cause?: unknown }): ConflictException | undefined {
  const cause = (e?.cause ?? e) as { code?: string; constraint?: string; detail?: string };
  if (cause?.code !== '23505') return undefined;
  const known = CONFLICTS[cause.constraint ?? ''];
  if (known) return new ConflictException({ error: 'conflict', message: known });
  if (/\(tenant_id, shared_id\)/.test(cause.detail ?? ''))
    return new ConflictException({
      error: 'shared_override_exists',
      message: 'This business already overrides that shared record',
    });
  return undefined;
}

@Injectable()
export class FeatureGateInterceptor implements NestInterceptor {
  constructor(
    private readonly gates: FeatureGates,
    @Inject(CORE_OPTIONS) private readonly options: CoreOptions,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    const req = context.switchToHttp().getRequest<ApiRequest>();
    return from(this.check(req)).pipe(
      switchMap(() => next.handle()),
      catchError((e: { cause?: unknown }) => throwError(() => asConflict(e) ?? e)),
    );
  }

  private async check(req: ApiRequest): Promise<void> {
    const p = req.principal;
    const path = req.route?.path as string | undefined;
    if (!p || !path) return;
    let catalog: Catalog;
    try {
      catalog = runtime().catalog;
    } catch {
      return;
    }
    const target = routeTargets(catalog).get(`${req.method} ${norm(path)}`);
    if (!target) return;
    const off = await this.gates.off(p.tenantId);
    if (target.kind === 'command') {
      if (commandOff(off, catalog, target.name)) throw switchedOff();
      return;
    }
    if (entityOff(off, catalog, target.spec.name)) throw switchedOff();
    if (target.list && hasCustomFields(target.spec) && p.tenantId)
      await this.checkCustomFilter(target.spec, req, p.tenantId);
  }

  /** A filter may name only the business's filterable custom fields of this entity. */
  private async checkCustomFilter(spec: EntitySpec, req: ApiRequest, tenantId: string) {
    const parsed = listQuerySchema(spec).safeParse(req.query);
    if (!parsed.success) return; // the validation pipe answers 400
    const keys = parsed.data.filters
      .filter((f) => f.field === 'custom')
      .flatMap((f) => Object.keys(f.value as object));
    if (!keys.length) return;
    const fields = await customFieldsOf(this.options.db, tenantId, spec.name);
    const filterable = new Set(fields.filter((f) => f.filterable).map((f) => f.key));
    const unknown = keys.filter((k) => !filterable.has(k));
    if (unknown.length)
      throw new BadRequestException({
        error: 'unknown_custom_field',
        message: `Not a filterable custom field of ${spec.label}: ${unknown.join(', ')}`,
      });
  }
}
