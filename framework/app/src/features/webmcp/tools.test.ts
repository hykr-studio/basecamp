// A screen's WebMCP tools: the assistant's read tools for the entities it reads, as the browser
// takes them, run through the API client with the person's session and the webmcp channel.
import { createApiClient } from '@hykr/api-client';
import { entitySpec, entityToolIds } from '@hykr/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { webMcpTools } from './tools';

const Row = z.object({
  id: z.string(),
  title: z.string(),
  state: z.enum(['open', 'shut']),
  dueOn: z.iso.date().nullable(),
});
type Expose = 'all' | 'human' | 'internal';
const spec = (
  name: string,
  expose: Record<'list' | 'get' | 'create' | 'update' | 'delete', Expose> = {
    list: 'all',
    get: 'all',
    create: 'all',
    update: 'all',
    delete: 'all',
  },
) =>
  entitySpec({
    name,
    label: name,
    description: `Test ${name}s.`,
    schemas: { read: Row, create: Row.omit({ id: true }), update: Row.partial() },
    list: {
      filterable: { state: 'enum', dueOn: 'date', title: 'text' },
      sortable: ['dueOn'],
      defaultSort: [['dueOn', 'asc']],
      search: ['title'],
      pageSize: { default: 50, max: 100 },
      toolPageSize: 10,
    },
    expose,
  });
const entities = {
  records: spec('record'),
  cards: spec('card', { list: 'human', get: 'all', create: 'all', update: 'all', delete: 'all' }),
  locks: spec('lock', {
    list: 'human',
    get: 'internal',
    create: 'all',
    update: 'all',
    delete: 'all',
  }),
};
const catalog = { entities };

/** The API, answering every call with `reply`; the calls it saw. */
function api(reply: (url: string) => { status: number; body: unknown }) {
  const calls: { url: string; init: RequestInit }[] = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const { status, body } = reply(url);
    return new Response(JSON.stringify(body), { status });
  });
  const client = createApiClient({
    baseUrl: 'https://api.test',
    credentials: 'include',
    headers: () => ({ 'x-channel': 'webmcp' }),
  });
  return { client, calls };
}
afterEach(() => {
  vi.unstubAllGlobals();
});

const offline = createApiClient({ baseUrl: 'https://api.test' });
const byName = (tools: { name: string }[]) => tools.map((t) => t.name);

describe('webMcpTools', () => {
  it('offers list and get of each entity read, with the assistant’s tool ids', () => {
    const tools = webMcpTools({ catalog, reads: ['records'], client: offline });
    expect(byName(tools)).toEqual(['list-records', 'get-record']);
    expect(byName(tools)).toEqual(entityToolIds(entities.records).slice(0, 2));
    expect(tools[0]).toMatchObject({
      title: 'List records',
      annotations: { readOnlyHint: true, untrustedContentHint: true },
    });
    expect(tools[0].description).toContain('Test records. Lists records with their ids.');
    expect(tools[0].description).toContain('At most 10 per call');
  });

  it('offers only what the spec opens to agents, and each tool once', () => {
    const tools = webMcpTools({
      catalog,
      reads: ['cards', 'locks', 'records', 'records', 'missing'],
      client: offline,
    });
    expect(byName(tools)).toEqual(['get-card', 'list-records', 'get-record']);
  });

  it('describes the input as JSON Schema: filters, enum values, the row cap', () => {
    const [list, get] = webMcpTools({ catalog, reads: ['records'], client: offline });
    const schema = list.inputSchema as {
      type: string;
      additionalProperties: boolean;
      properties: Record<string, { anyOf?: { enum?: string[] }[]; maximum?: number }>;
    };
    expect(schema.type).toBe('object');
    expect(schema.additionalProperties).toBe(false);
    expect(Object.keys(schema.properties)).toEqual(
      expect.arrayContaining(['state', 'dueOn', 'title', 'q', 'sort', 'limit', 'cursor']),
    );
    expect(schema.properties.state.anyOf?.[0].enum).toEqual(['open', 'shut']);
    expect(schema.properties.limit.maximum).toBe(10);
    expect(get.inputSchema).toMatchObject({ required: ['id'], properties: { id: {} } });
  });

  it('says which record is open when the screen shows one of its type', () => {
    const id = '7f0c2c63-8a4f-4b6c-9a3e-1d2b3c4d5e6f';
    const tools = webMcpTools({
      catalog,
      reads: ['records', 'cards'],
      client: offline,
      context: { screen: 'record', record: { type: 'record', id } },
    });
    expect(tools.find((t) => t.name === 'get-record')?.description).toContain(
      `The screen shows the record with id ${id}.`,
    );
    expect(tools.find((t) => t.name === 'get-card')?.description).not.toContain(id);
  });
});

describe('a tool call', () => {
  it('lists through the client: one GET with the filters and the row cap, the session and the channel', async () => {
    const { client, calls } = api(() => ({ status: 200, body: { items: [], nextCursor: null } }));
    const [list] = webMcpTools({ catalog, reads: ['records'], client });
    const out = await list.execute({ state: 'open', dueOn: { lt: '2030-01-01' } });
    expect(JSON.parse(out as string)).toEqual({
      ok: true,
      result: { items: [], nextCursor: null },
    });
    expect(calls).toHaveLength(1);
    const url = new URL(calls[0].url);
    expect(url.pathname).toBe('/api/records');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      limit: '10',
      state: 'open',
      'dueOn[lt]': '2030-01-01',
    });
    expect(calls[0].init).toMatchObject({
      method: 'GET',
      credentials: 'include',
      headers: { 'x-channel': 'webmcp' },
    });
  });

  it('asks for fewer rows when the input does', async () => {
    const { client, calls } = api(() => ({ status: 200, body: { items: [], nextCursor: null } }));
    const [list] = webMcpTools({ catalog, reads: ['records'], client });
    await list.execute({ limit: 3 });
    expect(new URL(calls[0].url).searchParams.get('limit')).toBe('3');
  });

  it('gets one record by id, and returns a refusal as data', async () => {
    const { client, calls } = api(() => ({ status: 404, body: { message: 'Not found' } }));
    const get = webMcpTools({ catalog, reads: ['records'], client })[1];
    const out = JSON.parse((await get.execute({ id: 'abc' })) as string);
    expect(out).toEqual({ ok: false, status: 404, error: { message: 'Not found' } });
    expect(calls.map((c) => [c.init.method, new URL(c.url).pathname])).toEqual([
      ['GET', '/api/records/abc'],
    ]);
  });

  it('sends nothing for an input the schema refuses', async () => {
    const { client, calls } = api(() => ({ status: 200, body: {} }));
    const [list, get] = webMcpTools({ catalog, reads: ['records'], client });
    for (const [tool, input] of [
      [list, { limit: 11 }],
      [list, { owner: 'someone' }],
      [list, { state: 'gone' }],
      [get, {}],
    ] as const) {
      const out = JSON.parse((await tool.execute(input)) as string);
      expect(out).toMatchObject({ ok: false, error: 'invalid_input' });
    }
    expect(calls).toHaveLength(0);
  });
});
