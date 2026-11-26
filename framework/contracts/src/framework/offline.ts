// Offline capture (B12): an entity or command a module marks `offline` may be written while the
// device has no network. The app queues the write on the device with its idempotency key and
// sends it later; the server takes it like any other write. Isomorphic: the server accepts a
// client-chosen id on create for these entities, the app decides what to queue from the same
// declaration. docs/decisions/B12.md.
import { z } from 'zod';
import type { CommandSpec, EntitySpec, WriteAction } from './spec.js';
import { versionedOf } from './versioned.js';

export interface OfflineTrait {
  /**
   * The writes the app may queue while offline. Default: every write. A create queued offline
   * carries the record's id, chosen on the device. Ignored on a command (it is one write).
   */
  writes?: readonly WriteAction[];
}

declare module './traits.js' {
  interface EntityTraits {
    offline?: OfflineTrait;
  }
  interface CommandTraits {
    offline?: OfflineTrait;
  }
}

const ALL: readonly WriteAction[] = ['create', 'update', 'delete'];

/** The spec's offline trait, if it has one. */
export const offlineOf = (spec: Pick<EntitySpec, 'traits'>): OfflineTrait | undefined =>
  spec.traits?.offline;

/** May this write of the entity be queued on the device while offline? */
export function queuesOffline(spec: Pick<EntitySpec, 'traits'>, action: WriteAction): boolean {
  const trait = offlineOf(spec);
  return trait !== undefined && (trait.writes ?? ALL).includes(action);
}

/** May this command be queued on the device while offline? */
export const commandQueuesOffline = (spec: Pick<CommandSpec, 'traits'>): boolean =>
  spec.traits?.offline !== undefined;

/**
 * Does a create of this entity take a client-chosen id? Every offline entity does, so a record
 * made offline has its id before it syncs (and later writes can refer to it).
 */
export const takesClientIds = (spec: Pick<EntitySpec, 'traits'>): boolean =>
  offlineOf(spec) !== undefined;

/** A record id a device chooses: a UUID. */
export const ClientId = z.uuid();

const inputs = new WeakMap<object, z.ZodObject>();

/**
 * What a create accepts: the spec's create schema, plus an optional client-chosen `id` when the
 * entity takes them. The spec's own schemas (the assistant's tools, MCP) never have it.
 */
export function createInputOf(spec: EntitySpec): z.ZodObject {
  const create = spec.schemas.create;
  if (!takesClientIds(spec)) return create;
  let out = inputs.get(spec);
  if (!out) {
    // safeExtend keeps the create schema's own refinements.
    out = create.safeExtend({ id: ClientId.optional() }) as unknown as z.ZodObject;
    inputs.set(spec, out);
  }
  return out;
}

/** What an `If-Match` header asks: any existing record, or one of these versions. */
export type IfMatch = { any: true } | { versions: readonly number[] };

/** Why an `If-Match` header cannot be read. */
export class IfMatchError extends Error {}

const TAG = /^(?:W\/)?"([^"]*)"$|^(\d+)$/;

/**
 * Read an `If-Match` header: `*`, or a list of entity tags (`"3"`, `W/"3"`, or a bare 3), each a
 * record version. Undefined when absent. Throws `IfMatchError` on anything else: a precondition
 * the server cannot check is never ignored.
 */
export function parseIfMatch(header: string | undefined | null): IfMatch | undefined {
  if (header === undefined || header === null) return undefined;
  const value = header.trim();
  if (!value) return undefined;
  if (value === '*') return { any: true };
  const versions: number[] = [];
  for (const part of value.split(',')) {
    const m = TAG.exec(part.trim());
    const raw = m?.[1] ?? m?.[2];
    if (raw === undefined || !/^\d{1,15}$/.test(raw))
      throw new IfMatchError(`If-Match: "${part.trim().slice(0, 40)}" is not a record version`);
    versions.push(Number(raw));
  }
  return { versions };
}

/** A record version as an entity tag: '"3"'. */
export const etagOf = (version: number | string): string => `"${String(version)}"`;

/**
 * Does the record's version satisfy the precondition? `*` matches any record; versions need an
 * entity with versions (B4) and its current one among them.
 */
export function ifMatchHolds(
  spec: Pick<EntitySpec, 'traits'>,
  row: Readonly<Record<string, unknown>>,
  want: IfMatch,
): boolean {
  if ('any' in want) return true;
  const trait = versionedOf(spec);
  if (!trait) return false;
  const now = Number(row[trait.field ?? 'version']);
  return want.versions.includes(now);
}
