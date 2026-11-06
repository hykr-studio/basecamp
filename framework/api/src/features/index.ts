// The framework's features, one export per line (a union merge keeps lines added in parallel).
// Each is a `defineFeature(...)` in its own folder; FeaturesModule loads every one of them.
export { eventsFeature } from './events/index.js';
export { filesFeature } from './files/index.js';
export { jobsFeature } from './jobs/index.js';
export { modelsFeature } from './models/index.js';
export { moneyFeature } from './money/index.js';
