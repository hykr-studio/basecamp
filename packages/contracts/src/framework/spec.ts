import type { Labels } from '@app/i18n';
import { z } from 'zod';
import type { Principal } from '../principal.js';
import type { ListConfig } from './list.js';

/**
 * Specs are the db-free half of an entity or command: names, schemas, list grammar and
 * what is exposed to whom. The API adds the table, owner and rules (@app/core); the agent's
 * tools and the typed client are built from the spec alone, so neither needs @app/db.
 */

/** Who made a record: the person, or the assistant acting for them. The framework sets it. */
export const CreatedBy = z.enum(['person', 'assistant']);
export type CreatedBy = z.infer<typeof CreatedBy>;

export type Expose = 'all' | 'human' | 'internal';
export type EntityAction = 'list' | 'get' | 'create' | 'update' | 'delete';
export type WriteAction = 'create' | 'update' | 'delete';
export type ApprovalRule = 'always' | 'never' | ((p: Principal) => boolean);

export interface EntitySpec<
  R extends z.ZodObject = z.ZodObject,
  C extends z.ZodObject = z.ZodObject,
  U extends z.ZodObject = z.ZodObject,
> {
  /** Singular, lower case: routes, command names (todo.create), tool ids, audit resourceType. */
  name: string;
  plural: string;
  pascal: string;
  /** How people say it: "to-do", "meeting". */
  label: string;
  /**
   * What people call each field, in every language (the approval preview). A field without one is shown with its name, humanized.
   */
  fieldLabels?: Partial<Record<keyof z.infer<R> & string, Labels>>;
  /** For tool descriptions and OpenAPI. */
  description: string;
  schemas: { read: R; create: C; update: U };
  list: ListConfig;
  expose: Record<EntityAction, Expose>;
  approval: Partial<Record<WriteAction, ApprovalRule>>;
  /**
   * The registered views (packages/ui-registry) its results are shown with: list results as
   * `list`, one record as `item`. Names only, so contracts stays free of the registry.
   */
  views?: { list?: string; item?: string };
}

export function entitySpec<R extends z.ZodObject, C extends z.ZodObject, U extends z.ZodObject>(
  spec: Omit<EntitySpec<R, C, U>, 'plural' | 'pascal' | 'expose' | 'approval'> &
    Partial<Pick<EntitySpec<R, C, U>, 'plural' | 'pascal' | 'expose' | 'approval'>>,
): EntitySpec<R, C, U> {
  return {
    plural: `${spec.name}s`,
    pascal: spec.name[0].toUpperCase() + spec.name.slice(1),
    ...spec,
    expose: {
      list: 'all',
      get: 'all',
      create: 'all',
      update: 'all',
      delete: 'all',
      ...spec.expose,
    },
    approval: spec.approval ?? {},
  };
}

export interface CommandSpec<I extends z.ZodObject = z.ZodObject, O extends z.ZodType = z.ZodType> {
  /** Dotted, as audited: 'meeting.close'. */
  name: string;
  description: string;
  input: I;
  output: O;
  /** Path params (:meetingId) are taken from the input; the rest is the body. */
  http: { method: 'POST' | 'PATCH' | 'PUT' | 'DELETE'; path: string };
  /** Tool id for the agent; omit to keep the command off the agent's tools. */
  tool?: string;
  expose: 'all' | 'human';
  /** For the tool description: when the agent's call is parked for approval. */
  approvalNote?: string;
  /** The registered view its result is shown with, and the record it shows. */
  view?: { name: string; id: (input: z.infer<I>) => string };
  /**
   * How people say it, for approval buttons and history: { do: 'close', did: 'closed' }
   * gives "Approve close" and "closed it". Defaults to the last part of the name.
   */
  verb?: { do: string; did: string };
  /** The entities (by name) it changes, so clients refresh exactly those after it runs. */
  touches?: string[];
}

export function commandSpec<I extends z.ZodObject, O extends z.ZodType>(
  spec: CommandSpec<I, O>,
): CommandSpec<I, O> {
  return spec;
}

/** The path params a command takes from its input, e.g. ['meetingId']. */
export function pathParams(path: string): string[] {
  return [...path.matchAll(/:([A-Za-z0-9_]+)/g)].map((m) => m[1]);
}
