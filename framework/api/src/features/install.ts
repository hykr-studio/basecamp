import { installContributions } from '@hykr/contracts';
import { type FeatureDef, isFeature } from './feature.js';
import * as barrel from './index.js';

let installed: readonly FeatureDef[] | undefined;

/**
 * Every enabled framework feature, its contributions installed into the registries. Once per
 * process: later calls return the same list. QueuesModule and FeaturesModule call it while the
 * app's modules are defined; the eval runner and Studio call it too, for the features' tools.
 */
export function installFeatures(): readonly FeatureDef[] {
  if (installed) return installed;
  const all = Object.values(barrel).filter(isFeature);
  const names = all.map((f) => f.name);
  const twice = names.find((n, i) => names.indexOf(n) !== i);
  if (twice) throw new Error(`The feature "${twice}" is exported twice from features/index.ts`);
  const enabled = all.filter((f) => f.enabled?.() ?? true);
  for (const f of enabled) if (f.contributes) installContributions(f.contributes);
  installed = enabled;
  return installed;
}
