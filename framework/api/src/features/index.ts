// The framework's features, one export per line (a union merge keeps lines added in parallel).
// Each is a `defineFeature(...)` in its own folder; FeaturesModule loads every one of them.
export { eventsFeature } from './events/index.js';
export { settingsFeature } from './settings/index.js';
