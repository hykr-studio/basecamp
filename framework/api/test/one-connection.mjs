// Every pg pool in the process gets ONE connection: a transaction that waits for a second
// pooled connection then fails its test instead of stalling the API (developer guide, section
// 5.8: nothing inside a transaction waits for another pooled connection). Load it with
//
//   NODE_OPTIONS="--import ./test/one-connection.mjs" pnpm vitest run        (framework/api)
//   NODE_OPTIONS="--import ../../framework/api/test/one-connection.mjs" pnpm vitest run   (application/api)
//
// A wait of POOL1_WAIT_MS (8 s) fails the acquire; with POOL1_LOG set, the waiting call's stack
// and the holder's (where it took the connection, and for how long) are appended there. Tests
// that need two connections by design (one that holds a row lock itself to make others wait)
// fail under it; everything else must pass with nothing logged.
import { appendFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../../db/package.json', import.meta.url));
const pg = require('pg');
const Base = Object.getPrototypeOf(pg.Pool.prototype);
const connect = Base.connect;
Error.stackTraceLimit = 80;
const wait = Number(process.env.POOL1_WAIT_MS ?? 8000);
const out = process.env.POOL1_LOG;
const trim = (s) =>
  String(s)
    .split('\n')
    .filter((l) => !/node_modules\/\.pnpm\/(drizzle|pg-pool)|node:internal|one-connection/.test(l))
    .slice(0, 25)
    .join('\n');
const note = (pool, site, e) => {
  if (!out || !String(e?.message).includes('timeout')) return;
  const idle = new Set(pool._idle.map((i) => i.client));
  const held = pool._clients.filter((c) => !idle.has(c));
  appendFileSync(
    out,
    `--- ${new Date().toISOString()} pid ${process.pid} WAITER\n${trim(site)}\n${held
      .map((c) => `  HOLDER held ${Date.now() - (c.__at ?? 0)} ms\n${trim(c.__site)}`)
      .join('\n')}\n`,
  );
};
const mark = (client, site) => {
  if (client) {
    client.__site = site;
    client.__at = Date.now();
  }
};
Base.connect = function (cb) {
  this.options.max = 1;
  this.options.connectionTimeoutMillis = wait;
  const site = new Error('one-connection site').stack;
  if (typeof cb === 'function')
    return connect.call(this, (e, client, done) => {
      if (e) note(this, site, e);
      else mark(client, site);
      return cb(e, client, done);
    });
  const p = connect.call(this);
  p.then(
    (client) => mark(client, site),
    (e) => note(this, site, e),
  );
  return p;
};
