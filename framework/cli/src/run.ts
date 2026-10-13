// `basecamp dev` and `basecamp start` run the API and the worker through this file, so that
// node --watch sees every module the server loads.
//
//   node run.js api|worker <compiled server module>
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const [kind, file] = process.argv.slice(2);
if ((kind !== 'api' && kind !== 'worker') || !file) {
  console.error('usage: run.js api|worker <server module>');
  process.exit(1);
}
// The application's own copy of @hykr/api: the one its server definition registers with.
const api = await import(pathToFileURL(createRequire(file).resolve('@hykr/api')).href);
const { server } = await import(pathToFileURL(file).href);
await (kind === 'api' ? api.startApi(server) : api.startWorker(server));
