// What applications and other features use of jobs on the server: declaring a kind, starting
// one inside a write, the service, the callback signature, and the helpers the tests share.
import './routes.js';

export { callbackSecret, type JobsConfig, jobsConfig } from './config.js';
export {
  type CompleteContext,
  defineJob,
  type JobCallbackOptions,
  type JobCallbackRequest,
  type JobCallbackTarget,
  type JobContext,
  type JobDef,
  type JobRecord,
  jobDefs,
  type SubmitContext,
  type SubmitResult,
} from './define.js';
export { checkResultUrl, fetchResult, isPrivateAddress, ResultRefused } from './fetch.js';
export { infoOf as jobInfoOf, JobEvent, type JobRow, presentJob, reachesJob } from './info.js';
export { JobRunner } from './runner.service.js';
export {
  JOB_SIGNATURE_HEADER,
  type JobSignatureCheck,
  signJobCallback,
  verifyJobCallback,
} from './signature.js';
export { startJob } from './start.js';
