// Bulk import (B20): any served entity can be imported from a file through the write path,
// unless its spec opts out. Records with a parent are saved through their parent's command and
// are never imported on their own.
import type { EntitySpec } from './spec.js';

declare module './traits.js' {
  interface EntityTraits {
    /** `false`: this entity's records are never imported from a file (`basecamp import`). */
    imports?: false;
  }
}

/** Why an entity cannot be imported, or undefined when it can. */
export function notImportable(spec: EntitySpec): string | undefined {
  if (spec.traits?.imports === false) return `${spec.label} records are not imported from files`;
  if (spec.traits?.parent)
    return `${spec.label} records are saved with their ${spec.traits.parent.entity}`;
  return undefined;
}
