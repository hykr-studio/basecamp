// `basecamp dev` and `basecamp start` run the API, the worker and Studio through this file, so
// that node --watch sees every module they load.
//
//   node run.js api|worker|studio <compiled server module>
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const [kind, file] = process.argv.slice(2);
if (!['api', 'worker', 'studio'].includes(kind ?? '') || !file) {
  console.error('usage: run.js api|worker|studio <server module>');
  process.exit(1);
}
// The application's own copy of @hykr/api: the one its server definition registers with.
const api = await import(pathToFileURL(createRequire(file).resolve('@hykr/api')).href);
const { server } = await import(pathToFileURL(file).href);
if (kind === 'api') await api.startApi(server);
else if (kind === 'worker') await api.startWorker(server);
// In dev: waits for the API, and steps aside if Studio already runs elsewhere.
else if (!(await api.startStudio(server, process.cwd(), { dev: true }))) process.exit(0);
