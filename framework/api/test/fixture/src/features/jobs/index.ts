// The jobs feature in use (B11): a `drawings` module whose drawings are rendered by a
// long-running job on an outside service, and a job about no record that converts text. The
// service is a stand-in the e2e test runs (its address in FIXTURE_JOBS_URL):
// - `fixture.render` is about a drawing: callbacks in the framework's signed format, result files
//   inline and by URL (fetched with its own `download`), `cancel`, and a `complete` that puts a
//   copy of the first page on the drawing with its page count;
// - `fixture.convert` is about no record and takes no callbacks: the worker polls it. Its input
//   may name a file, which its starter must reach;
// - `fixture.export` has no service: its `submit` does the work in the worker, as its starter,
//   reports progress and returns its file as bytes.
// Starting either is a command: the assistant's render waits for the person's approval. Staff
// never see what a render cost (a read projector on jobs).
import { call, defineScript, say, written } from '@hykr/agents/script';
import {
  defineJob,
  defineModule,
  defineServer,
  presentJob,
  ResultRefused,
  startJob,
} from '@hykr/api';
import {
  type Contributions,
  CreatedBy,
  commandSpec,
  entitySpec,
  FileRef,
  JobInfo,
  moduleSpec,
} from '@hykr/contracts';
import {
  allow,
  commandController,
  commandHandler,
  defineCommand,
  defineEntity,
  entityController,
  entityHandlers,
  entityOp,
  needsApproval,
  type ReadProjector,
} from '@hykr/core';
import type { Access } from '@hykr/policy';
import { Module } from '@nestjs/common';
import { z } from 'zod';
import { fixture } from '../../index.js';
import { drawings } from './schema.js';

const title = z.string().min(1).max(200);

/* ── The drawing ───────────────────────────────────────────────────────────── */

export const Drawing = z.object({
  id: z.string(),
  title,
  preview: FileRef.nullable(),
  pages: z.number().int().nullable(),
  createdBy: CreatedBy,
  createdAt: z.iso.datetime(),
});

export const DrawingSpec = entitySpec({
  name: 'drawing',
  label: 'drawing',
  description: 'Drawings: a title, and the preview and page count of their latest render.',
  schemas: {
    read: Drawing,
    create: z.object({ title }),
    update: z.object({
      title: title.optional(),
      preview: FileRef.nullable().optional(),
      pages: z.number().int().min(0).nullable().optional(),
    }),
  },
  list: {
    filterable: { title: 'text' },
    sortable: ['createdAt'],
    defaultSort: [['createdAt', 'asc']],
    pageSize: { default: 50, max: 100 },
  },
  traits: { files: { preview: { accept: ['image/*'] } } },
});

/** Everyone in the business reads every drawing; staff change only their own. */
const ACCESS: Access = {
  read: { owner: 'tenant', admin: 'tenant', ops: 'tenant', staff: 'tenant', customer: 'customer' },
  write: { owner: 'tenant', admin: 'tenant', ops: 'tenant', staff: 'own', customer: 'customer' },
};

export const DrawingDef = defineEntity(DrawingSpec, {
  table: drawings,
  owner: (t) => t.ownerId,
  customer: (t) => t.customerId,
  access: ACCESS,
});

/* ── The stand-in service ──────────────────────────────────────────────────── */

const service = () => {
  const url = process.env.FIXTURE_JOBS_URL;
  if (!url) throw new Error('FIXTURE_JOBS_URL is not set: the stand-in service is not running');
  return url;
};

async function post(path: string, body: unknown, signal: AbortSignal) {
  const res = await fetch(`${service()}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) throw new Error(`The service answered ${res.status}`);
  return (await res.json()) as Record<string, unknown>;
}

/* ── The jobs ──────────────────────────────────────────────────────────────── */

export const RenderInput = z.object({
  drawingId: z.uuid(),
  quality: z.enum(['draft', 'final']),
});

/** Renders a drawing: callbacks, inline and URL files, cancel, and a write-back. */
export const RenderJob = defineJob({
  name: 'fixture.render',
  description: 'Renders a drawing on the outside rendering service.',
  input: RenderInput,
  output: z.object({ pages: z.number().int().min(0), cost: z.number().optional() }),
  about: { entity: 'drawing', id: (i) => i.drawingId },
  timeoutMs: 10 * 60_000,
  submitAttempts: 2,
  submitBackoffMs: 200,
  submit: async (ctx) => {
    const { id } = await post(
      '/submit',
      { job: ctx.job.id, kind: ctx.job.kind, input: ctx.job.input, callback: ctx.callback },
      ctx.signal,
    );
    return { externalId: String(id) };
  },
  cancel: async (ctx) => {
    await post(`/cancel/${ctx.job.externalId ?? ctx.job.id}`, {}, ctx.signal);
  },
  // The service's files need no credentials, but live on its own (loopback) address: only
  // those are fetched, never another URL a callback names.
  download: async (file, ctx) => {
    if (!file.url.startsWith(`${service()}/files/`))
      throw new ResultRefused('Not a file of the rendering service');
    const res = await fetch(file.url, { signal: ctx.signal });
    if (!res.ok) throw new Error(`The service answered ${res.status} for ${file.name}`);
    return Buffer.from(await res.arrayBuffer());
  },
  complete: async (ctx) => {
    const [first] = ctx.job.files;
    const preview = first ? await ctx.copyFile(first) : undefined;
    const out = await ctx.write(entityOp(DrawingDef, 'update', { id: ctx.job.input.drawingId }), {
      pages: ctx.job.output.pages,
      ...(preview ? { preview } : {}),
    });
    if (out.status !== 'done') throw new Error(`The drawing was not updated (${out.status})`);
  },
});

export const ConvertInput = z.object({
  text: z.string().min(1).max(200),
  /** A file to convert along with the text: its starter must reach it. */
  source: FileRef.optional(),
});

/** About no record, polled only: its starter alone reaches it. */
export const ConvertJob = defineJob({
  name: 'fixture.convert',
  description: 'Converts a text on the outside service, which never calls back.',
  input: ConvertInput,
  inputFiles: (i) => (i.source ? [i.source] : []),
  timeoutMs: 10 * 60_000,
  callback: false,
  pollEveryMs: 1_000,
  submit: async (ctx) => {
    const source = ctx.job.input.source
      ? (await ctx.fileBytes(ctx.job.input.source)).toString('base64')
      : null;
    const { id } = await post(
      '/submit',
      { job: ctx.job.id, kind: ctx.job.kind, input: ctx.job.input, source, callback: null },
      ctx.signal,
    );
    return { externalId: String(id) };
  },
  poll: async (ctx) => {
    const res = await fetch(`${service()}/status/${ctx.job.externalId}`, { signal: ctx.signal });
    if (!res.ok) throw new Error(`The service answered ${res.status}`);
    const { update } = (await res.json()) as { update?: unknown };
    return (update ?? null) as never;
  },
});

export const ExportInput = z.object({
  title,
  /** A transient error: the first attempt throws once it has reported progress. */
  flaky: z.boolean().optional(),
});

/**
 * Work done here, in the worker, as whoever started it: no service, no callback, no poll. It
 * reports progress, counts the drawings its starter can read, and makes a file.
 */
export const ExportJob = defineJob({
  name: 'fixture.export',
  description: 'Exports the drawings its starter can read as a CSV file.',
  input: ExportInput,
  output: z.object({ drawings: z.number().int() }),
  timeoutMs: 60_000,
  callback: false,
  submitBackoffMs: 200,
  submit: async (ctx) => {
    await ctx.progress(50, 'Writing');
    if (ctx.job.input.flaky && ctx.job.attempt === 1) throw new Error('The disk was busy');
    const p = await ctx.starter();
    const list = await DrawingDef.repo.list(ctx.db, p, { limit: 100 });
    const rows = list.items.map((d) => `${d.id},${d.title}`);
    return {
      update: { status: 'succeeded', output: { drawings: rows.length }, message: 'Written' },
      files: [
        {
          name: `${ctx.job.input.title}.csv`,
          mime: 'text/csv',
          bytes: Buffer.from(['id,title', ...rows].join('\n')),
        },
      ],
    };
  },
});

/* ── Starting them: commands ───────────────────────────────────────────────── */

export const RenderDrawingSpec = commandSpec({
  name: 'drawing.render',
  description:
    'Render a drawing on the rendering service. It takes minutes: the job reports progress.',
  input: z.object({ drawingId: z.uuid(), quality: z.enum(['draft', 'final']).default('draft') }),
  output: JobInfo,
  http: { method: 'POST', path: '/api/drawings/:drawingId/render' },
  tool: 'render-drawing',
  expose: 'all',
  verb: { do: 'render', did: 'rendered' },
  touches: [],
});

export const ConvertTextSpec = commandSpec({
  name: 'drawing.convert',
  description: 'Convert a text (and a file) on the outside service.',
  input: ConvertInput,
  output: JobInfo,
  http: { method: 'POST', path: '/api/drawings/convert' },
  tool: 'convert-text',
  expose: 'human',
  verb: { do: 'convert', did: 'converted' },
  touches: [],
});

/** Whoever may change the drawing renders it; the assistant asks first. */
export const RenderDrawing = defineCommand(RenderDrawingSpec, {
  resource: { type: 'drawing', id: (input) => input.drawingId },
  load: (tx, p, input) => DrawingDef.repo.get(tx, p, input.drawingId),
  authorize: (p, drawing) => {
    const may = DrawingDef.decide(p, 'update', drawing, {});
    if (may.decision === 'deny') return may;
    return p.actor.kind === 'agent'
      ? needsApproval('fixture.render_asks', 'The assistant asks before rendering')
      : allow('fixture.render');
  },
  summarize: (input, drawing) => `Render "${drawing.title}" (${input.quality})`,
  run: async ({ tx, principal, input, loaded }) => ({
    value: await startJob(tx, principal, RenderJob, {
      drawingId: loaded.id,
      quality: input.quality,
    }),
    touched: [],
  }),
  present: (job, p) => presentJob(job, p),
});

export const ConvertText = defineCommand(ConvertTextSpec, {
  resource: { type: 'drawing', id: () => null },
  authorize: () => allow('fixture.convert'),
  summarize: (input) => `Convert "${input.text}"`,
  run: async ({ tx, principal, input }) => ({
    value: await startJob(tx, principal, ConvertJob, input),
    touched: [],
  }),
  present: (job, p) => presentJob(job, p),
});

export const ExportDrawingsSpec = commandSpec({
  name: 'drawing.export',
  description: 'Export the drawings as a CSV file.',
  input: ExportInput,
  output: JobInfo,
  http: { method: 'POST', path: '/api/drawings/export' },
  tool: 'export-drawings',
  expose: 'human',
  verb: { do: 'export', did: 'exported' },
  touches: [],
});

export const ExportDrawings = defineCommand(ExportDrawingsSpec, {
  resource: { type: 'drawing', id: () => null },
  authorize: () => allow('fixture.export'),
  summarize: (input) => `Export "${input.title}"`,
  run: async ({ tx, principal, input }) => ({
    value: await startJob(tx, principal, ExportJob, input),
    touched: [],
  }),
  present: (job, p) => presentJob(job, p),
});

@Module({
  controllers: [
    entityController(DrawingDef),
    commandController(RenderDrawing),
    commandController(ConvertText),
    commandController(ExportDrawings),
  ],
  providers: [
    ...entityHandlers(DrawingDef),
    commandHandler(RenderDrawing),
    commandHandler(ConvertText),
    commandHandler(ExportDrawings),
  ],
})
export class DrawingsModule {}

/* ── The assistant ─────────────────────────────────────────────────────────── */

const UUID = '([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})';

/** "render drawing <id>": the render waits for the person's approval. */
export const drawingScripts = [
  defineScript({
    name: 'render-drawing',
    match: (text) => new RegExp(`^render drawing ${UUID}$`, 'i').exec(text.trim())?.[1],
    step: (drawingId, turn) => {
      const r = turn.result('render-drawing');
      if (!r) return [call('render-drawing', { drawingId, quality: 'draft' })];
      return [say(written(r, () => 'The render has started.', turn))];
    },
  }),
];

/* ── Hidden from staff ─────────────────────────────────────────────────────── */

/** Staff never see what a render cost: not in a job, a list, an event or a file's reach. */
export const hideJobCost: ReadProjector = {
  name: 'fixture.jobs.cost',
  project: (type, value, p) => {
    if (type !== 'job' || !p.roles?.includes('staff')) return value;
    const output = value.output;
    if (!output || typeof output !== 'object' || !('cost' in output)) return value;
    const { cost: _hidden, ...rest } = output as Record<string, unknown>;
    return { ...value, output: rest };
  },
};

export const drawingsModule = defineModule({
  ...moduleSpec({
    name: 'drawings',
    dependsOn: [],
    entities: { drawings: DrawingSpec },
    commands: [RenderDrawingSpec, ConvertTextSpec, ExportDrawingsSpec],
  }),
  server: DrawingsModule,
  agent: { scripts: drawingScripts },
  tables: { drawings },
  contributes: { jobs: [RenderJob, ConvertJob, ExportJob] },
});

export const jobsContributions: Partial<Contributions> = { readProjectors: [hideJobCost] };

/** The fixture plus drawings. */
export const jobsApp = defineServer({
  ...fixture.definition,
  modules: [...fixture.definition.modules, drawingsModule],
  contributes: jobsContributions,
});
