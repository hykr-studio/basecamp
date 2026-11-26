// State transitions over MCP (A1 with B6): `<module>_write` moves a record by a transition an
// agent may ask for, through POST /api/transitions with the client's token. A move runs, or parks
// and answers with the link to the request in the app; the route needs the module's write scope;
// people-only and system moves are not offered and stay refused; another business's record is a
// 404; a field hidden from the person stays hidden in the moved record. The fixture's tickets
// (fixture/src/features/states).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addMember,
  boot,
  connectMcp,
  type Json,
  type McpConnection,
  me,
  Person,
  pool,
  server,
  shutdown,
} from '../../dist/testing.js';
import { statesServer } from '../fixture/dist/features/states/index.js';

const owner = new Person('Owner Mcp States');
const staff = new Person('Staff Mcp States');
const other = new Person('Other Mcp States');
let tenantId = '';
let client: McpConnection;

type Ticket = { id: string; title: string; status: string; note?: string | null };

const create = async (person: Person, title: string, extra: object = {}, headers = {}) => {
  const res = await person.call('POST', '/api/tickets', { title, ...extra }, headers);
  if (res.status !== 201 && res.status !== 200) throw new Error(JSON.stringify(res.body));
  return res.body.value as Ticket;
};

/** The JSON after a tool's first line (a done move: the record). */
const jsonOf = (text: string) => JSON.parse(text.slice(text.indexOf('\n') + 1));

/** The REST API with a bearer token, as a client might call it directly. */
const withToken =
  (token: string) =>
  async (method: string, path: string, body?: unknown): Promise<{ status: number; body: Json }> => {
    const res = await fetch(`${server.base}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };

const audit = async (resourceId: string) =>
  (
    await pool.query(
      `select actor_id, channel, outcome, run_id from audit.events
        where resource_id = $1 and action = 'ticket.transition' order by at`,
      [resourceId],
    )
  ).rows;

const move = (id: string, transition: string, fields: object = {}) =>
  client.call('tickets_write', {
    action: 'transition-tickets',
    input: { id, transition, ...fields },
  });

beforeAll(async () => {
  await boot(statesServer);
  for (const p of [owner, staff, other]) await p.signUp();
  tenantId = (await me(owner)).tenantId;
  await addMember(staff, tenantId, ['staff']);
  expect((await staff.call('PUT', '/api/me/default', { tenantId })).status).toBe(200);
  client = await connectMcp(owner, 'tickets:write');
});
afterAll(async () => {
  await client?.close();
  await shutdown();
});

describe('a transition over MCP', () => {
  it('runs, audited as the client on the mcp channel', async () => {
    const ticket = await create(owner, 'Leaky tap');
    const moved = await move(ticket.id, 'start');
    expect(moved.isError).toBe(false);
    expect(moved.text).toMatch(/^Moved the ticket: start, now active\./);
    expect(jsonOf(moved.text)).toMatchObject({ id: ticket.id, status: 'active' });
    const [row] = await audit(ticket.id);
    expect(row).toMatchObject({
      actor_id: `mcp:${client.clientId}`,
      channel: 'mcp',
      outcome: 'committed',
    });
    expect(row.run_id).toMatch(/^mcp-/);
  });

  it("takes the transition's own fields, and refuses any other", async () => {
    const ticket = await create(owner, 'Broken latch');
    const needs = await move(ticket.id, 'resolve');
    expect(needs.isError).toBe(true);
    expect(needs.text).toContain('transition_requires');
    const extra = await move(ticket.id, 'resolve', { resolution: 'Fixed', title: 'Renamed' });
    expect(extra.isError).toBe(true);
    expect(extra.text).toContain('takes only resolution, note, not title');
    const resolved = await move(ticket.id, 'resolve', { resolution: 'Fixed' });
    expect(jsonOf(resolved.text)).toMatchObject({ status: 'resolved', resolution: 'Fixed' });
  });

  it('parks a move at its level and answers with the link where a person decides it', async () => {
    const ticket = await create(owner, 'Final check');
    await owner.call('POST', `/api/transitions/tickets/${ticket.id}/resolve`, {
      resolution: 'Done',
    });
    const asked = await move(ticket.id, 'close');
    expect(asked.isError).toBe(false);
    expect(asked.text).toContain('Not done yet');
    expect(asked.text).toContain('Level: Final.');
    const link = /(http\S+\/approvals\/([0-9a-f-]{36}))/.exec(asked.text);
    expect(link?.[1]).toBe(
      `${process.env.APP_URL ?? 'http://localhost:8081'}/approvals/${link?.[2]}`,
    );
    const parked = (await audit(ticket.id)).find((r) => r.outcome === 'needs_approval');
    expect(parked).toMatchObject({ actor_id: `mcp:${client.clientId}`, channel: 'mcp' });
    const approval = (await owner.call('GET', `/api/approvals/${link?.[2]}`)).body;
    expect(approval).toMatchObject({
      status: 'pending',
      requestedBy: 'agent',
      level: { name: 'fixture_tickets_final' },
      input: { transition: 'close' },
    });
    // Nothing moved; a person decides in the app.
    expect((await owner.call('GET', `/api/tickets/${ticket.id}`)).body.status).toBe('resolved');
  });

  it('offers no people-only or system move, and the API refuses them', async () => {
    const ticket = await create(owner, 'Reopen me');
    await owner.call('POST', `/api/transitions/tickets/${ticket.id}/resolve`, {
      resolution: 'Done',
    });
    for (const name of ['reopen', 'escalate', 'supersede']) {
      const refused = await move(ticket.id, name);
      expect(refused.isError, name).toBe(true);
      expect(refused.text, name).toContain('input.transition must be one of start, resolve');
    }
    const direct = await withToken(client.accessToken)(
      'POST',
      `/api/transitions/tickets/${ticket.id}/reopen`,
      {},
    );
    expect(direct).toMatchObject({ status: 403, body: { rule: 'humans_only' } });
  });

  it("never reaches another business's record", async () => {
    const theirs = await create(other, 'Not yours');
    const refused = await move(theirs.id, 'start');
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain('404');
    expect(refused.text).not.toContain('Not yours');
    expect((await other.call('GET', `/api/tickets/${theirs.id}`)).body.status).toBe('open');
  });

  it('keeps a field hidden from the person hidden in the moved record', async () => {
    const ticket = await create(
      staff,
      'Staff ticket',
      { note: 'Private' },
      {
        'x-tenant-id': tenantId,
      },
    );
    const staffClient = await connectMcp(staff, 'tickets:write');
    try {
      const moved = await staffClient.call('tickets_write', {
        action: 'transition-tickets',
        input: { id: ticket.id, transition: 'start' },
      });
      expect(moved.isError).toBe(false);
      const record = jsonOf(moved.text);
      expect(record).toMatchObject({ id: ticket.id, status: 'active' });
      expect(record).not.toHaveProperty('note');
      expect(moved.text).not.toContain('Private');
    } finally {
      await staffClient.close();
    }
  });
});

describe('the transitions route and scopes', () => {
  it("needs the write scope of the records' module", async () => {
    const ticket = await create(owner, 'Scoped');
    const reader = await connectMcp(owner, 'tickets:read');
    const elsewhere = await connectMcp(owner, 'tasks:write');
    try {
      expect(await reader.tools()).toEqual(['tickets_read']);
      for (const c of [reader, elsewhere]) {
        const res = await withToken(c.accessToken)(
          'POST',
          `/api/transitions/tickets/${ticket.id}/start`,
          {},
        );
        expect(res.status).toBe(403);
        expect(res.body).toMatchObject({ rule: 'out_of_scope' });
        expect(res.body.reason).toBe('This connection was not allowed to write tickets');
      }
      // No such records: no module, so no scope opens it.
      const unknown = await withToken(client.accessToken)(
        'POST',
        `/api/transitions/nothings/${ticket.id}/start`,
        {},
      );
      expect(unknown).toMatchObject({ status: 403, body: { rule: 'out_of_scope' } });
      expect((await owner.call('GET', `/api/tickets/${ticket.id}`)).body.status).toBe('open');
      // The module's write scope opens it.
      const ok = await withToken(client.accessToken)(
        'POST',
        `/api/transitions/tickets/${ticket.id}/start`,
        {},
      );
      expect(ok).toMatchObject({ status: 200, body: { status: 'done' } });
    } finally {
      await reader.close();
      await elsewhere.close();
    }
  });
});
