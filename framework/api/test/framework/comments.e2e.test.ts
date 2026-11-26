// Comments and @-mentions (B16): comments on any record a person can read, reached only through
// that record; mentions checked against who may read it, told through the in-app inbox and the
// durable `comment.mentioned` event; the assistant's and customers' comments parked by the
// entity's rule, and comments naming a helper by the application's level rule, edits as much as
// adds; live announcements to the record's readers; erasure and export. The real write path,
// outbox, relay, queues and Redis, in one process (inline).
import { type LiveMessage, liveMessages, textOf } from '@hykr/api-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addMember,
  asAssistant,
  boot,
  eventually,
  me,
  origin,
  Person,
  pool,
  server,
  shutdown,
} from '../../dist/testing.js';
import { commentsApp, heard } from '../fixture/dist/features/comments/index.js';

const ana = new Person('Ana Talk');
const olga = new Person('Olga Talk');
const adam = new Person('Adam Talk');
const sam = new Person('Sam Talk');
const cleo = new Person('Cleo Talk');
const ravi = new Person('Ravi Talk');
let tenantId = '';
/** For members of Ana's business who also have a business of their own. */
const inA: Record<string, string> = {};
let taskId = '';
let cleoTaskId = '';

const token = (p: Person, label = 'someone') => `@[${label}](user:${p.id})`;
const list = (who: Person, id = taskId, extra = '') =>
  who.call('GET', `/api/comments?entity=task&id=${id}${extra}`, undefined, inA);
const add = (who: Person, body: string, more: Record<string, unknown> = {}, id = taskId) =>
  who.call('POST', '/api/comments', { entity: 'task', recordId: id, body, ...more }, inA);
const inbox = (who: Person) => who.call('GET', '/api/inbox', undefined, inA);
const assistant = () => asAssistant(`user:${ana.id}`, { 'x-channel': 'app' });

/** A customer of Ana's business with an account: reads only their own customer's records. */
async function addCustomer(person: Person) {
  const { rows } = await pool.query(
    `insert into app.customers (tenant_id, display_name, user_id) values ($1, $2, $3) returning id`,
    [tenantId, person.name, person.id],
  );
  await pool.query(
    `insert into app.memberships (tenant_id, user_id, roles, customer_id, is_default)
     values ($1, $2, '{customer}', $3, false)
     on conflict (tenant_id, user_id) do update set roles = excluded.roles, customer_id = excluded.customer_id`,
    [tenantId, person.id, rows[0].id],
  );
}

const edit = (who: Person, id: string, body: string) =>
  who.call('PATCH', `/api/comments/${id}`, { body }, inA);
const approve = (who: Person, id: string) =>
  who.call('POST', `/api/approvals/${id}/approve`, undefined, inA);
/** The targets named in `comment.mentioned` events about one comment, in order. */
const mentionedIn = async (commentId: string) =>
  (
    await pool.query(
      `select row->'target'->>'id' as who from app.domain_events
       where name = 'comment.mentioned' and resource_id = $1 order by occurred_at`,
      [commentId],
    )
  ).rows.map((r) => r.who);

/** This business's approval settings, replaced (a write reads them in its own transaction). */
async function approvalsSettings(approvals: object) {
  await pool.query(
    `update app.tenants set settings = jsonb_set(settings, '{approvals}', $2::jsonb) where id = $1`,
    [tenantId, JSON.stringify(approvals)],
  );
}

const audit = async (action: string, resourceId: string) =>
  (
    await pool.query(
      `select action, outcome, rule, resource_type, resource_id, actor_kind from audit.events
       where action = $1 and resource_id = $2 order by at`,
      [action, resourceId],
    )
  ).rows;

beforeAll(async () => {
  await boot(commentsApp);
  for (const p of [ana, olga, adam, sam, cleo, ravi]) await p.signUp();
  tenantId = (await me(ana)).tenantId;
  inA['x-tenant-id'] = tenantId;
  // Olga sees the whole business; Adam too, and may remove others' comments; Sam only his own
  // rows; Cleo is a customer.
  await addMember(olga, tenantId, ['ops']);
  await addMember(adam, tenantId, ['admin']);
  await addMember(sam, tenantId, ['staff']);
  await addCustomer(cleo);
  taskId = (await ana.call('POST', '/api/tasks', { title: 'Plan the week' })).body.value.id;
  cleoTaskId = (await cleo.call('POST', '/api/tasks', { title: "Cleo's request" }, inA)).body.value
    .id;
});
afterAll(shutdown);

describe('comments on a record', () => {
  let first = '';

  it('a reader comments; the list is newest first, page by page', async () => {
    const one = await add(ana, 'First thoughts');
    expect(one.status).toBe(200);
    expect(one.body).toMatchObject({
      status: 'done',
      value: {
        on: { entity: 'task', id: taskId },
        body: 'First thoughts',
        mentions: [],
        internal: false,
        anchor: null,
        author: { id: ana.id, name: 'Ana Talk' },
        createdBy: 'person',
        editedAt: null,
        can: { edit: true, remove: true },
      },
    });
    first = one.body.value.id;
    const two = await add(ana, 'Second thoughts');
    const page = await list(ana, taskId, '&limit=1');
    expect(page.status).toBe(200);
    expect(page.body.items.map((c: { id: string }) => c.id)).toEqual([two.body.value.id]);
    const older = await list(ana, taskId, `&limit=1&cursor=${page.body.nextCursor}`);
    expect(older.body.items.map((c: { id: string }) => c.id)).toEqual([first]);
    expect(older.body.nextCursor).toBeNull();
  });

  it('comments that share a time, or one millisecond, page once each (V12)', async () => {
    // Three of one microsecond, two either side within its millisecond, the next millisecond and
    // the next day: a cursor that kept a Date's millisecond skipped the rest of it.
    const times = [
      '2026-03-01 00:00:00.0005+00',
      '2026-03-01 00:00:00.0005+00',
      '2026-03-01 00:00:00.0005+00',
      '2026-03-01 00:00:00.0001+00',
      '2026-03-01 00:00:00.0009+00',
      '2026-03-01 00:00:00.001+00',
      '2026-03-02 00:00:00+00',
    ];
    const on = (await ana.call('POST', '/api/tasks', { title: 'Paged talk' })).body.value.id;
    for (const [i, at] of times.entries()) {
      const res = await add(ana, `Comment ${i}`, {}, on);
      expect(res.status).toBe(200);
      await pool.query('update app.comments set created_at = $2 where id = $1', [
        res.body.value.id,
        at,
      ]);
    }
    const all = (
      await pool.query(
        'select id from app.comments where tenant_id = $1 and resource_id = $2 order by created_at desc, id desc',
        [tenantId, on],
      )
    ).rows.map((r: { id: string }) => r.id);
    expect(all).toHaveLength(times.length);
    for (const limit of [1, 2]) {
      const seen: string[] = [];
      let cursor: string | null = null;
      for (let i = 0; i < 60 && (i === 0 || cursor); i++) {
        const res = await list(ana, on, `&limit=${limit}${cursor ? `&cursor=${cursor}` : ''}`);
        expect(res.status, JSON.stringify(res.body)).toBe(200);
        seen.push(...res.body.items.map((c: { id: string }) => c.id));
        cursor = res.body.nextCursor;
      }
      expect(cursor, 'the walk never ended').toBeNull();
      expect(seen, `limit=${limit}`).toEqual(all);
    }
  });

  it('another business, and staff who reach only their own rows, get 404 for everything', async () => {
    const all = [
      await ravi.call('GET', `/api/comments?entity=task&id=${taskId}`),
      await ravi.call('POST', '/api/comments', { entity: 'task', recordId: taskId, body: 'Hi' }),
      await ravi.call('PATCH', `/api/comments/${first}`, { body: 'Mine now' }),
      await ravi.call('DELETE', `/api/comments/${first}`),
      await list(sam),
      await add(sam, 'Can I?'),
      await sam.call('PATCH', `/api/comments/${first}`, { body: 'Mine now' }, inA),
    ];
    expect(all.map((r) => [r.status, r.body?.rule ?? r.body?.error])).toEqual(
      all.map(() => [404, 'not_found']),
    );
    // The business sees it.
    expect((await list(olga)).body.items).toHaveLength(2);
    const { rows } = await pool.query(
      'select count(*)::int as n from app.comments where resource_id = $1',
      [taskId],
    );
    expect(rows[0].n).toBe(2);
  });

  it('only the author edits; the author or a moderator removes', async () => {
    const olgas = await add(olga, 'From ops');
    expect(olgas.body.value.can).toEqual({ edit: true, remove: true });
    // Olga reads Ana's comment, but may not change it.
    const seen = (await list(olga)).body.items.find((c: { id: string }) => c.id === first);
    expect(seen.can).toEqual({ edit: false, remove: false });
    const edit = await olga.call('PATCH', `/api/comments/${first}`, { body: 'Changed' }, inA);
    expect(edit.status).toBe(403);
    expect(edit.body).toMatchObject({ rule: 'not_author' });
    expect(await audit('comment.edit', taskId)).toContainEqual(
      expect.objectContaining({ outcome: 'denied', rule: 'not_author' }),
    );
    const remove = await olga.call('DELETE', `/api/comments/${first}`, undefined, inA);
    expect(remove.status).toBe(403);
    // Ana edits her own.
    const edited = await ana.call('PATCH', `/api/comments/${first}`, { body: 'First, revised' });
    expect(edited.body.value).toMatchObject({ body: 'First, revised' });
    expect(edited.body.value.editedAt).not.toBeNull();
    // Adam (admin) removes Olga's.
    const removed = await adam.call(
      'DELETE',
      `/api/comments/${olgas.body.value.id}`,
      undefined,
      inA,
    );
    expect(removed.body).toMatchObject({
      status: 'done',
      value: { id: olgas.body.value.id, removed: true },
    });
    expect((await list(ana)).body.items).toHaveLength(2);
  });

  it("each command's audit row names the record; the comment row is audited too", async () => {
    expect(await audit('comment.add', taskId)).toContainEqual(
      expect.objectContaining({ outcome: 'committed', resource_type: 'task', actor_kind: 'user' }),
    );
    const { rows } = await pool.query(
      `select action, resource_type from audit.events where resource_id = $1`,
      [first],
    );
    expect(rows).toEqual(
      expect.arrayContaining([
        { action: 'comment.create', resource_type: 'comment' },
        { action: 'comment.update', resource_type: 'comment' },
      ]),
    );
    const history = await ana.call('GET', `/api/history?resourceType=task&resourceId=${taskId}`);
    expect(history.body.map((e: { action: string }) => e.action)).toContain('comment.add');
  });

  it('a record type that takes no comments, an unknown one, and anchors', async () => {
    const visit = await ana.call('POST', '/api/visits', {
      title: 'Walkthrough',
      startsAt: '2030-01-01T10:00:00Z',
      endsAt: '2030-01-01T11:00:00Z',
    });
    const visitId = visit.body.value.id;
    const off = await ana.call('POST', '/api/comments', {
      entity: 'visit',
      recordId: visitId,
      body: 'Hello',
    });
    expect(off.status).toBe(403);
    expect(off.body).toMatchObject({ rule: 'comments_off' });
    expect(await audit('comment.add', visitId)).toEqual([
      expect.objectContaining({ outcome: 'denied', rule: 'comments_off', resource_type: 'visit' }),
    ]);
    expect((await ana.call('GET', `/api/comments?entity=visit&id=${visitId}`)).body.items).toEqual(
      [],
    );
    const unknown = await ana.call('POST', '/api/comments', {
      entity: 'nothing',
      recordId: taskId,
      body: 'Hello',
    });
    expect(unknown.status).toBe(400);
    expect(unknown.body).toMatchObject({ error: 'unknown_entity' });
    // Tasks take an anchor of their own shape; pages take none.
    const pinned = await add(ana, 'On version two', { anchor: { version: 2 } });
    expect(pinned.body.value.anchor).toEqual({ version: 2 });
    expect((await add(ana, 'Bad pin', { anchor: { version: 0 } })).body).toMatchObject({
      error: 'bad_anchor',
    });
    const page = await ana.call('POST', '/api/pages', {
      name: 'Numbers',
      spec: {
        title: 'Numbers',
        layout: 'stack',
        blocks: [{ id: 'k', view: 'kpi.row', props: { items: [{ label: 'Open', value: 3 }] } }],
      },
    });
    const onPage = await ana.call('POST', '/api/comments', {
      entity: 'page',
      recordId: page.body.value.id,
      body: 'Pinned',
      anchor: { version: 1 },
    });
    expect(onPage.status).toBe(400);
    expect(onPage.body).toMatchObject({ error: 'anchor_not_accepted' });
    const plain = await ana.call('POST', '/api/comments', {
      entity: 'page',
      recordId: page.body.value.id,
      body: 'A page takes comments too',
    });
    expect(plain.body.status).toBe('done');
  });
});

describe('mentions', () => {
  let mentionId = '';

  it('a reader is named with the name the server knows, told in their inbox, and the event is stored', async () => {
    const res = await add(ana, `Can you check this ${token(olga, 'the boss')}? ${token(ana)}`);
    expect(res.status).toBe(200);
    mentionId = res.body.value.id;
    expect(res.body.value.body).toBe(
      `Can you check this @[Olga Talk](user:${olga.id})? @[Ana Talk](user:${ana.id})`,
    );
    expect(res.body.value.mentions).toEqual([
      { kind: 'user', id: olga.id, label: 'Olga Talk' },
      { kind: 'user', id: ana.id, label: 'Ana Talk' },
    ]);
    const box = await eventually(async () => {
      const b = (await inbox(olga)).body;
      return b.items.length ? b : undefined;
    });
    expect(box.unread).toBe(1);
    expect(box.items[0]).toMatchObject({
      notification: 'comment.mention',
      title: 'Ana Talk mentioned you',
      body: 'Can you check this @Olga Talk? @Ana Talk',
      record: { type: 'task', id: taskId },
      url: null,
      readAt: null,
    });
    // The durable event, once per person named (never the author), for the agents' trigger.
    const { rows } = await pool.query(
      `select row from app.domain_events where name = 'comment.mentioned' and resource_id = $1`,
      [mentionId],
    );
    expect(rows.map((r) => r.row)).toEqual([
      {
        id: mentionId,
        tenantId,
        commentId: mentionId,
        on: { entity: 'task', id: taskId },
        target: { kind: 'user', id: olga.id, label: 'Olga Talk' },
        author: { id: ana.id, name: 'Ana Talk' },
        internal: false,
        excerpt: 'Can you check this @Olga Talk? @Ana Talk',
      },
    ]);
    const relayed = await eventually(() =>
      heard.find((e) => e.resourceId === mentionId && e.name === 'comment.mentioned'),
    );
    expect(relayed).toMatchObject({ resourceType: 'comment', actor: { kind: 'user', id: ana.id } });
    // Ana named herself: nothing in her inbox.
    expect((await inbox(ana)).body.items).toEqual([]);
  });

  it('naming someone who cannot read the record refuses the comment, audited, and stores nothing', async () => {
    for (const who of [sam, ravi]) {
      const res = await add(ana, `Look ${token(who)}`);
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ rule: 'mention_not_allowed' });
      // It does not say who.
      expect(JSON.stringify(res.body)).not.toContain(who.id);
    }
    const unknownKind = await add(ana, 'Look @[Thing](robot:r1)');
    expect(unknownKind.body).toMatchObject({ rule: 'mention_not_allowed' });
    expect(await audit('comment.add', taskId)).toContainEqual(
      expect.objectContaining({ outcome: 'denied', rule: 'mention_not_allowed' }),
    );
    const { rows } = await pool.query(
      `select count(*)::int as n from app.comments where body like 'Look%'`,
    );
    expect(rows[0].n).toBe(0);
  });

  it("a feature's own kind of mention is checked by its resolver and raises the event", async () => {
    const res = await add(ana, 'Over to @[x](helper:helper7)');
    expect(res.body.value.mentions).toEqual([{ kind: 'helper', id: 'helper7', label: 'Helper 7' }]);
    await eventually(() =>
      heard.find((e) => (e.row as { target?: { id: string } }).target?.id === 'helper7'),
    );
    expect((await add(ana, 'Over to @[x](helper:other)')).status).toBe(403);
    // At most 20 different targets in one comment.
    const many = Array.from({ length: 21 }, (_, i) => `@[h](helper:helper${i})`).join(' ');
    const tooMany = await add(ana, many);
    expect(tooMany.status).toBe(400);
    expect(tooMany.body).toMatchObject({ error: 'too_many_mentions' });
  });

  it('an edit tells only the people it newly names', async () => {
    const res = await ana.call('PATCH', `/api/comments/${mentionId}`, {
      body: `Again ${token(olga)} and ${token(adam)}`,
    });
    expect(res.body.status).toBe('done');
    await eventually(async () => ((await inbox(adam)).body.items.length ? true : undefined));
    const { rows } = await pool.query(
      `select row->'target'->>'id' as who from app.domain_events
       where name = 'comment.mentioned' and resource_id = $1 order by occurred_at`,
      [mentionId],
    );
    expect(rows.map((r) => r.who)).toEqual([olga.id, adam.id]);
    expect((await inbox(olga)).body.items).toHaveLength(1);
  });

  it('the picker offers people who may read the record, and other kinds', async () => {
    const picked = await ana.call('GET', `/api/comments/mentionable?entity=task&id=${taskId}&q=ol`);
    expect(picked.body.items).toEqual([{ kind: 'user', id: olga.id, label: 'Olga Talk' }]);
    const all = await ana.call('GET', `/api/comments/mentionable?entity=task&id=${taskId}`);
    const ids = all.body.items.map((m: { id: string }) => m.id);
    expect(ids).toEqual(expect.arrayContaining([ana.id, olga.id, adam.id, 'helper1']));
    expect(ids).not.toContain(sam.id);
    expect(ids).not.toContain(ravi.id);
    expect(
      (await ravi.call('GET', `/api/comments/mentionable?entity=task&id=${taskId}`)).status,
    ).toBe(404);
  });

  it('the inbox: people only, mark read, all read, and nobody else’s items', async () => {
    const box = (await inbox(olga)).body;
    const itemId = box.items[0].id;
    expect(
      (await asAssistant(`user:${olga.id}`, { 'x-channel': 'app' })('GET', '/api/inbox')).status,
    ).toBe(403);
    // Ana cannot mark Olga's item read.
    expect((await ana.call('POST', '/api/inbox/read', { ids: [itemId] })).status).toBe(204);
    expect((await inbox(olga)).body.unread).toBe(1);
    expect((await olga.call('POST', '/api/inbox/read', { ids: [itemId] }, inA)).status).toBe(204);
    const after = (await inbox(olga)).body;
    expect(after.unread).toBe(0);
    expect(after.items[0].readAt).not.toBeNull();
    expect((await olga.call('GET', '/api/inbox?unread=true', undefined, inA)).body.items).toEqual(
      [],
    );
    expect((await adam.call('POST', '/api/inbox/read', { all: true }, inA)).status).toBe(204);
    expect((await inbox(adam)).body.unread).toBe(0);
    expect((await olga.call('POST', '/api/inbox/read', {}, inA)).status).toBe(400);
  });

  it("any notification can list the inbox: a task titled 'Inbox…' leaves one, with its link", async () => {
    const created = await ana.call('POST', '/api/tasks', { title: 'Inbox me' });
    const item = await eventually(async () =>
      (await inbox(ana)).body.items.find(
        (i: { notification: string }) => i.notification === 'task.inboxed',
      ),
    );
    expect(item).toMatchObject({
      title: 'New task: Inbox me (en)',
      body: 'It was added.',
      url: `/tasks/${created.body.value.id}`,
      record: { type: 'task', id: created.body.value.id },
    });
  });
});

describe('team-only comments', () => {
  it('customers never see them, cannot write them and cannot be named in them', async () => {
    const internal = await add(ana, 'Between us', { internal: true }, cleoTaskId);
    expect(internal.body.value.internal).toBe(true);
    await add(ana, `For you ${token(cleo)}`, {}, cleoTaskId);
    const cleos = (await list(cleo, cleoTaskId)).body.items;
    expect(cleos.map((c: { body: string }) => c.body)).toEqual([
      `For you @[Cleo Talk](user:${cleo.id})`,
    ]);
    expect((await list(olga, cleoTaskId)).body.items).toHaveLength(2);
    const own = await add(cleo, 'Mine is secret', { internal: true }, cleoTaskId);
    expect(own.status).toBe(403);
    expect(own.body).toMatchObject({ rule: 'internal_comments' });
    const naming = await add(ana, `Secret ${token(cleo)}`, { internal: true }, cleoTaskId);
    expect(naming.body).toMatchObject({ rule: 'mention_not_allowed' });
    // Cleo was told of the comment meant for her.
    await eventually(async () => ((await inbox(cleo)).body.items.length ? true : undefined));
    const picker = await ana.call(
      'GET',
      `/api/comments/mentionable?entity=task&id=${cleoTaskId}&internal=true`,
    );
    expect(picker.body.items.map((m: { id: string }) => m.id)).not.toContain(cleo.id);
    // She cannot edit or remove what she cannot see.
    expect(
      (await cleo.call('DELETE', `/api/comments/${internal.body.value.id}`, undefined, inA)).status,
    ).toBe(404);
  });
});

describe('the assistant', () => {
  it('reads comments; its comment waits for the person, unless team-only; edits are people’s', async () => {
    const run = assistant();
    const read = await run('GET', `/api/comments?entity=task&id=${taskId}`);
    expect(read.status).toBe(200);
    const parked = await run('POST', '/api/comments', {
      entity: 'task',
      recordId: taskId,
      body: 'Drafted by the assistant',
    });
    expect(parked.body).toMatchObject({ status: 'needs_approval' });
    const approval = parked.body.approval;
    expect(approval).toMatchObject({ resourceType: 'task', resourceId: taskId });
    expect(await audit('comment.add', taskId)).toContainEqual(
      expect.objectContaining({ outcome: 'needs_approval', actor_kind: 'agent' }),
    );
    const before = (await list(ana)).body.items.length;
    const approved = await ana.call('POST', `/api/approvals/${approval.id}/approve`);
    expect(approved.body).toMatchObject({ status: 'approved' });
    const after = (await list(ana)).body.items;
    expect(after).toHaveLength(before + 1);
    expect(after[0]).toMatchObject({
      body: 'Drafted by the assistant',
      createdBy: 'assistant',
      author: { id: ana.id },
    });
    const internal = await run('POST', '/api/comments', {
      entity: 'task',
      recordId: taskId,
      body: 'A team note',
      internal: true,
    });
    expect(internal.body.status).toBe('done');
    expect((await run('PATCH', `/api/comments/${after[0].id}`, { body: 'x' })).status).toBe(403);
    expect((await run('DELETE', `/api/comments/${after[0].id}`)).status).toBe(403);
  });

  it('the scripted model lists, adds (parked) and offers people to mention', async () => {
    const listed = await ana.chat(`comments on task ${taskId}`);
    expect(listed.body.reply).toMatch(/^\d+ comments\. The latest, from Ana Talk: "A team note"$/);
    const added = await ana.chat(`comment on task ${taskId}: Please look again`);
    expect(added.body.reply).toContain("I've asked for your approval: Comment on task");
    const offered = await ana.chat(`who can I mention on task ${taskId}`);
    expect(offered.body.reply).toContain('Olga Talk');
    const refused = await ravi.chat(`comments on task ${taskId}`);
    expect(refused.body.reply).toContain('No such task');
  });
});

describe('an edit passes the same gates as an add', () => {
  it("a customer's comment waits for the business, and so does every edit of it", async () => {
    const parked = await add(cleo, 'Can the colour be lighter?', {}, cleoTaskId);
    expect(parked.body).toMatchObject({
      status: 'needs_approval',
      approval: { resourceType: 'task', resourceId: cleoTaskId },
    });
    expect((await approve(ana, parked.body.approval.id)).body).toMatchObject({
      status: 'approved',
    });
    const mine = (await list(cleo, cleoTaskId)).body.items.find(
      (c: { body: string }) => c.body === 'Can the colour be lighter?',
    );
    expect(mine).toMatchObject({ author: { id: cleo.id }, can: { edit: true } });

    // The approved text cannot be swapped for another, nor name someone new, without approval.
    const changed = await edit(cleo, mine.id, `Call me instead ${token(olga)}`);
    expect(changed.status).toBe(200);
    expect(changed.body).toMatchObject({
      status: 'needs_approval',
      approval: { resourceType: 'task', resourceId: cleoTaskId },
    });
    expect(await audit('comment.edit', cleoTaskId)).toContainEqual(
      expect.objectContaining({
        outcome: 'needs_approval',
        rule: 'comment_needs_approval',
        actor_kind: 'user',
      }),
    );
    const waiting = (await list(cleo, cleoTaskId)).body.items.find(
      (c: { id: string }) => c.id === mine.id,
    );
    expect(waiting).toMatchObject({ body: 'Can the colour be lighter?', editedAt: null });
    expect(await mentionedIn(mine.id)).toEqual([]);

    // Approved, the edit runs as Cleo, and Olga is told then.
    expect((await approve(ana, changed.body.approval.id)).body).toMatchObject({
      status: 'approved',
    });
    const edited = (await list(cleo, cleoTaskId)).body.items.find(
      (c: { id: string }) => c.id === mine.id,
    );
    expect(edited.body).toBe(`Call me instead @[Olga Talk](user:${olga.id})`);
    expect(edited.editedAt).not.toBeNull();
    expect(await mentionedIn(mine.id)).toEqual([olga.id]);
  });

  it("a level rule decides edits too: a business that makes the helpers' level wait", async () => {
    await approvalsSettings({ levels: { fixture_helpers: { parks: true } } });
    try {
      // Naming a helper is at the application's helpers level, which this business makes wait.
      const parked = await add(ana, 'Ask @[x](helper:helper3)');
      expect(parked.body).toMatchObject({
        status: 'needs_approval',
        approval: { resourceType: 'task', level: { name: 'fixture_helpers' } },
      });
      expect((await approve(ana, parked.body.approval.id)).body).toMatchObject({
        status: 'approved',
      });
      const asked = (await list(ana)).body.items.find(
        (c: { body: string }) => c.body === 'Ask @[Helper 3](helper:helper3)',
      );
      expect(asked).toBeDefined();
      const again = await edit(ana, asked.id, 'Ask @[x](helper:helper3) by Friday');
      expect(again.body).toMatchObject({
        status: 'needs_approval',
        approval: { level: { name: 'fixture_helpers' } },
      });
      // The edit's input has only the new text: the rule reads the comment it would write.
      const plain = await add(ana, 'No helpers here');
      expect(plain.body.status).toBe('done');
      const naming = await edit(ana, plain.body.value.id, 'Now @[x](helper:helper4)');
      expect(naming.body).toMatchObject({ status: 'needs_approval' });
      expect(await audit('comment.edit', taskId)).toContainEqual(
        expect.objectContaining({ outcome: 'needs_approval', actor_kind: 'user' }),
      );
      expect(await mentionedIn(plain.body.value.id)).toEqual([]);
    } finally {
      await approvalsSettings({});
    }
    // The level's own policy: a person's edit runs at once.
    const plainNow = (await list(ana)).body.items.find(
      (c: { body: string }) => c.body === 'No helpers here',
    );
    const runs = await edit(ana, plainNow.id, 'Now @[x](helper:helper4)');
    expect(runs.body).toMatchObject({ status: 'done' });
    expect(await mentionedIn(plainNow.id)).toEqual(['helper4']);
  });
});

describe('live', () => {
  type Stream = { messages: LiveMessage[]; close: () => void };
  const open: Stream[] = [];
  afterAll(() => {
    for (const s of open) s.close();
  });
  async function stream(who: Person): Promise<Stream> {
    const controller = new AbortController();
    const res = await fetch(`${server.base}/api/live`, {
      headers: { origin, cookie: who.cookie, ...inA },
      signal: controller.signal,
    });
    const s: Stream = { messages: [], close: () => controller.abort() };
    open.push(s);
    void (async () => {
      try {
        for await (const m of liveMessages(textOf(res.body as ReadableStream<Uint8Array>)))
          s.messages.push(m);
      } catch {
        // aborted
      }
    })();
    await eventually(() => s.messages.find((m) => m.kind === 'ready'));
    return s;
  }
  const about = (s: Stream, type: string) =>
    s.messages.flatMap((m) => (m.kind === 'change' && m.event.type === type ? [m.event] : []));

  it("a comment reaches the record's readers; an inbox item only its owner", async () => {
    const olgaS = await stream(olga);
    const samS = await stream(sam);
    const adamS = await stream(adam);
    const res = await add(ana, `Live ${token(olga)}`);
    const id = res.body.value.id;
    await eventually(() =>
      about(olgaS, 'comment').some((e) => e.id === id && e.name === 'comment.added')
        ? true
        : undefined,
    );
    await eventually(() => (about(olgaS, 'inbox').length ? true : undefined));
    await eventually(() => (about(adamS, 'comment').some((e) => e.id === id) ? true : undefined));
    await new Promise((r) => setTimeout(r, 1500));
    expect(about(samS, 'comment')).toEqual([]);
    expect(about(adamS, 'inbox')).toEqual([]);
  });
});

describe('personal data', () => {
  it('erasing a person deletes what they wrote and got, and unnames them elsewhere', async () => {
    const { DB } = await import('../../dist/infra/db.module.js');
    const { CommentsErasure, CommentsExport } = await import(
      '../../dist/features/comments/privacy.js'
    );
    const { InboxErasure, InboxExport } = await import('../../dist/features/inbox/index.js');
    const db = server.app?.get(DB, { strict: false });
    const subject = { kind: 'user' as const, userId: olga.id };
    const exported = await CommentsExport.export({ subject, db });
    expect(exported.comments).toEqual([]);
    expect((await InboxExport.export({ subject, db })).inbox?.length).toBeGreaterThan(0);
    await add(olga, 'Olga was here');
    await db.transaction(async (tx: never) => {
      await CommentsErasure.erase({ subject, tx });
      await InboxErasure.erase({ subject, tx });
    });
    const bodies = (await list(ana)).body.items.map((c: { body: string }) => c.body);
    expect(bodies).not.toContain('Olga was here');
    expect(bodies.join('\n')).not.toContain(olga.id);
    expect(bodies).toContain(`Again @— and @[Adam Talk](user:${adam.id})`);
    const { rows } = await pool.query(
      'select count(*)::int as n from channel.inbox_items where user_id = $1',
      [olga.id],
    );
    expect(rows[0].n).toBe(0);
    const anas = await CommentsExport.export({ subject: { kind: 'user', userId: ana.id }, db });
    expect(anas.comments?.length).toBeGreaterThan(3);
  });
});
