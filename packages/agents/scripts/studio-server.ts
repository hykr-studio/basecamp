// Serves the Mastra instance over HTTP for Mastra Studio, without `mastra dev`.
//
// `mastra dev` bundles the project first, and Mastra 1.74's dev bundler resolves scoped
// workspace packages (@app/contracts, @app/api-client) against the wrong package.json.
// Serving the instance directly with the Hono adapter avoids the bundler entirely.
import { serve } from '@hono/node-server';
import { type HonoBindings, type HonoVariables, MastraServer } from '@mastra/hono';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { mastra } from '../src/mastra/index.js';

const port = Number(process.env.MASTRA_PORT ?? 4111);
const studioOrigin = process.env.STUDIO_ORIGIN ?? 'http://localhost:4000';

const app = new Hono<{ Bindings: HonoBindings; Variables: HonoVariables }>();
app.use('*', cors({ origin: studioOrigin, credentials: true }));
await new MastraServer({ app, mastra }).init();

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`Mastra server for Studio on http://localhost:${info.port}`);
});
