// First in every worker, before a test file imports anything: this worker's own database and
// Redis keys (see testing-workers.ts).
import { useWorker } from '../dist/testing-workers.js';

useWorker();
