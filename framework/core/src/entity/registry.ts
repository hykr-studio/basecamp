import { createHookRegistry } from '@hykr/contracts';
import type { AnyEntityDef } from './define-entity.js';

/**
 * The entities this process serves, by name: `entityHandlers(def)` registers each one. Features
 * find an entity here from a resource type (an approval's, an event's, an audit row's) to read
 * or project its records. A second entity with the same name or plural throws.
 */
export const entityRegistry = createHookRegistry<AnyEntityDef>('entity', (d) => d.name);

/**
 * Serve this entity: it is found by name, plural and read schema from now on. The same
 * definition again is a no-op (a module's forRoot called twice); another one of the same name
 * or plural throws.
 */
export function registerEntityDef(def: AnyEntityDef): void {
  if (entityRegistry.get(def.name) === def) return;
  const clash = entityRegistry.all().find((d) => d.plural === def.plural && d.name !== def.name);
  if (clash)
    throw new Error(
      `The entities "${clash.name}" and "${def.name}" share the plural "${def.plural}"`,
    );
  entityRegistry.register(def);
}

/** Every served entity, in the order they were registered. */
export const entityDefs = (): readonly AnyEntityDef[] => entityRegistry.all();

/** The served entity of this name ('task'), if any. */
export const entityDef = (name: string): AnyEntityDef | undefined => entityRegistry.get(name);

let index: { of: readonly AnyEntityDef[]; bySchema: Map<unknown, AnyEntityDef> } | undefined;

/**
 * The served entity whose read schema is this very schema object, if any: a command's output
 * that reuses `Meeting` is read and projected as a meeting.
 */
export function entityDefForSchema(schema: unknown): AnyEntityDef | undefined {
  const all = entityRegistry.all();
  if (index?.of !== all) {
    const bySchema = new Map<unknown, AnyEntityDef>();
    for (const d of all)
      if (!bySchema.has(d.spec.schemas.read)) bySchema.set(d.spec.schemas.read, d);
    index = { of: all, bySchema };
  }
  return index.bySchema.get(schema);
}
