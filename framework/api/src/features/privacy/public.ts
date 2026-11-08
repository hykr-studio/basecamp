// What applications and tests use of the privacy feature: processors, the policy, retention
// targets and periods, and the service that carries out requests.
export { ARCHIVE_FIELD, PrivacyService, type RunOutcome } from './privacy.service.js';
export { personalEntities, personalEntityProblems } from './records.js';
export { type Redacted, redactCopies } from './redact.js';
export {
  definePersonalDataPart,
  definePrivacyPolicy,
  defineProcessor,
  type PersonalDataPart,
  type PrivacyPolicy,
  type ProcessorDef,
  personalDataParts,
  privacyPolicies,
  processors,
  type RecordCopies,
  type RetentionPeriod,
  type RetentionTarget,
  recordCopies,
  retentionPeriods,
  retentionTargets,
} from './registry.js';
export { type Identities, identitiesOf } from './subject.js';
