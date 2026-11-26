import { orderScriptSets } from './script-set.js';
import * as sets from './scripts/index.js';

/**
 * Scripts for the framework's own features, in every domain, before the domain's own: every
 * set in scripts/ (one file per feature), by each set's `order`.
 */
export const platformScripts = orderScriptSets(Object.values(sets));
