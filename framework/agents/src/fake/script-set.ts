import type { Script } from './engine.js';

/**
 * One feature's scripts for the scripted model, in its own file under scripts/ and on its own
 * line in scripts/index.ts. `order` places the set among the others (the first script that
 * matches runs): pages 100, handoff 200, testing 900; pick a free number. Inside a set, the
 * scripts keep their order.
 */
export type ScriptSet = { name: string; order: number; scripts: readonly Script[] };

export const defineScriptSet = (set: ScriptSet): ScriptSet => set;

/**
 * Every set's scripts, by `order`, then name. A set or script name used twice throws: the
 * scripted model matches the first one, so the second would never run.
 */
export function orderScriptSets(sets: readonly ScriptSet[]): Script[] {
  const sorted = [...sets].sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
  const names = new Set<string>();
  const seen = new Set<string>();
  for (const set of sorted) {
    if (names.has(set.name)) throw new Error(`Two script sets are named "${set.name}"`);
    names.add(set.name);
    for (const script of set.scripts) {
      if (seen.has(script.name))
        throw new Error(`The script "${script.name}" is in two sets (the second is "${set.name}")`);
      seen.add(script.name);
    }
  }
  return sorted.flatMap((set) => [...set.scripts]);
}
