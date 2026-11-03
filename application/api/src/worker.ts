import { startWorker } from '@hykr/api';
import { server } from './server.js';

await startWorker(server);
