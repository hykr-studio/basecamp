import { uiDomain } from './domain/index.js';
import { platformScreens, platformViews } from './platform/index.js';
import { createRegistry } from './registry.js';

/** This system's registry: the framework's own views and screens, plus the domain's. */
export const registry = createRegistry({
  views: [...platformViews, ...uiDomain.views],
  screens: [...platformScreens, ...uiDomain.screens],
});
