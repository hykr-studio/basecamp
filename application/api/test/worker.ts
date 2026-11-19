// First in every worker, before a test file imports anything: this worker's own database and
// Redis keys.
import { useWorker } from '@hykr/api/testing/workers';

useWorker();
