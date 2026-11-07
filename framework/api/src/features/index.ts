// The framework's features, one export per line (a union merge keeps lines added in parallel).
// Each is a `defineFeature(...)` in its own folder; FeaturesModule loads every one of them.

export { approvalsFeature } from './approvals/index.js';
export { creditsFeature } from './credits/index.js';
export { eventsFeature } from './events/index.js';
export { filesFeature } from './files/index.js';
export { integrationsFeature } from './integrations/index.js';
export { jobsFeature } from './jobs/index.js';
export { liveFeature } from './live/index.js';
export { modelsFeature } from './models/index.js';
export { moneyFeature } from './money/index.js';
export { pushFeature } from './push/index.js';
export { resumeFeature } from './resume/index.js';
