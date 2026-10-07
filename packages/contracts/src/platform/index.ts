/**
 * Entities the framework itself owns, in every domain: saved canvas pages.
 */
import { SavedPageSpec } from './page.js';

export * from './page.js';

export const platformEntities = { pages: SavedPageSpec } as const;
