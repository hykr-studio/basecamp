// What applications and tests use of the privacy feature: processors, the policy, retention
// targets and periods, and the service that carries out requests.
export { ARCHIVE_FIELD, PrivacyService, type RunOutcome } from './privacy.service.js';
export { personalEntities, personalEntityProblems } from './records.js';
export { type Redacted, redactCopies } from './redact.js';
export {
  definePrivacyPolicy,
  defineProcessor,
  type ErasedRecords,
  type PrivacyPolicy,
  type ProcessorDef,
  privacyPolicies,
  processors,
  type RetentionPeriod,
  type RetentionTarget,
  retentionPeriods,
  retentionTargets,
} from './registry.js';
export { type Identities, identitiesOf } from './subject.js';
