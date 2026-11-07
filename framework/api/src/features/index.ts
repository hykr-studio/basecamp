// The framework's features, one export per line (a union merge keeps lines added in parallel).
// Each is a `defineFeature(...)` in its own folder; FeaturesModule loads every one of them.

export { acceptanceFeature } from './acceptance/index.js';
export { approvalsFeature } from './approvals/index.js';
export { commentsFeature } from './comments/index.js';
export { creditsFeature } from './credits/index.js';
export { documentsFeature } from './documents/index.js';
export { eventsFeature } from './events/index.js';
export { exportFeature } from './export/index.js';
export { filesFeature } from './files/index.js';
export { inboxFeature } from './inbox/index.js';
export { integrationsFeature } from './integrations/index.js';
export { jobsFeature } from './jobs/index.js';
export { liveFeature } from './live/index.js';
export { membersFeature } from './members/index.js';
export { memoryFeature } from './memory/index.js';
export { modelsFeature } from './models/index.js';
export { moneyFeature } from './money/index.js';
export { partiesFeature } from './parties/index.js';
export { pushFeature } from './push/index.js';
export { resumeFeature } from './resume/index.js';
export { settingsFeature } from './settings/index.js';
export { slaFeature } from './sla/index.js';
export { statesFeature } from './states/index.js';
export { versionsFeature } from './versions/index.js';
