// What applications, connectors and tests use of acceptances on the server: declaring one, the
// e-sign provider interface, and the service that reads evidence and records a provider's result.
import './routes.js';

export { AcceptanceService } from './acceptance.service.js';
export { AcceptanceEvidenceCapability } from './capability.js';
export {
  type AcceptanceDef,
  type AcceptanceSigner,
  type AcceptedContext,
  acceptances,
  defineAcceptance,
} from './define.js';
export {
  defineESignProvider,
  type ESignProvider,
  type ESignResult,
  type ESignStart,
  type ESignStarted,
  esignProviders,
} from './esign.js';
export { hashOf as evidenceHash } from './evidence.js';
