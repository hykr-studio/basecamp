// A business's settings sections, changed by the business (H2): one writer for every section
// declared `editable` and for the base settings' `general`, through the write path (validated,
// unknown keys refused, checked for meaning, authorized by the section's capability, audited,
// announced as settings.changed). The fixture's claims (fixture/src/features/settings/claims.ts)
// show a new threshold, band approver, SLA duration and business hours taking effect.
import { addBusinessTime, openHoursOf, type SlaTimer } from '@hykr/contracts';
import { TenantConfigService } from '@hykr/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addMember,
  asAssistant,
  boot,
  me,
  Person,
  pool,
  server,
  shutdown,
} from '../../dist/testing.js';
import { settingsSectionsApp } from '../fixture/dist/features/settings/claims.js';

const owner = new Person('Owner Sections');
const admin = new Person('Admin Sections');
const ops = new Person('Ops Sections');
const staff = new Person('Staff Sections');
const other = new Person('Other Sections');
let tenantId = '';
let otherTenant = '';
const inTenant = () => ({ 'x-tenant-id': tenantId });
const as = (p: Person) => ([admin, ops, staff].includes(p) ? inTenant() : {});

const eur = (minor: number) => ({ minor, currency: 'EUR' });

const patch = (person: Person, section: string, value: unknown, headers = as(person)) =>
  person.call('PATCH', `/api/settings/sections/${section}`, { value }, headers);
const read = (person: Person, section: string) =>
  person.call('GET', `/api/settings/sections/${section}`, undefined, as(person));

/** What the business stored, as it is in its row. */
const stored = async (tenant = tenantId) =>
  (await pool.query('select settings from app.tenants where id = $1', [tenant])).rows[0].settings;

/** The settings writes of a business, as audited: the command's row. */
const audit = async (tenant = tenantId) =>
  (
    await pool.query(
      `select outcome, rule, actor_kind, request_id from audit.events
       where action = 'settings.section' and tenant_id = $1 order by at`,
      [tenant],
    )
  ).rows;
/** The business's settings before and after one write: its touched row (tenant.update). */
const changes = async (tenant = tenantId) =>
  (
    await pool.query(
      `select before, after from audit.events
       where action = 'tenant.update' and tenant_id = $1 order by at`,
      [tenant],
    )
  ).rows;

type Claim = { id: string; status: string };
const claim = (person: Person, amountMinor: number, currency = 'EUR') =>
  person.call(
    'POST',
    '/api/claims',
    { title: `Claim ${amountMinor}`, amountMinor, currency },
    as(person),
  );
const timers = async (id: string) =>
  (await owner.call('GET', `/api/sla/claims/${id}`)).body as SlaTimer[];

const config = () => {
  if (!server.app) throw new Error('The app is not booted');
  return server.app.get(TenantConfigService, { strict: false }) as TenantConfigService;
};

const problemsOf = (res: { status: number; body: { error?: string; problems?: string[] } }) => {
  expect(res.status).toBe(400);
  expect(res.body.error).toBe('settings_invalid');
  return res.body.problems ?? [];
};

beforeAll(async () => {
  await boot(settingsSectionsApp);
  for (const p of [owner, admin, ops, staff, other]) await p.signUp();
  tenantId = (await me(owner)).tenantId;
  otherTenant = (await me(other)).tenantId;
  await addMember(admin, tenantId, ['admin']);
  await addMember(ops, tenantId, ['ops']);
  await addMember(staff, tenantId, ['staff']);
});
afterAll(shutdown);

describe('reading the sections', () => {
  it('lists what this person may change, general first, defaults applied', async () => {
    const res = await owner.call('GET', '/api/settings/sections');
    expect(res.status).toBe(200);
    const keys = res.body.map((s: { key: string }) => s.key);
    expect(keys[0]).toBe('general');
    for (const key of [
      'approvals',
      'money',
      'businessHours',
      'sla',
      'memory',
      'shares',
      'files',
      'parties',
      'fixtureClaims',
    ])
      expect(keys).toContain(key);
    // Sections with a writer of their own are not here.
    for (const key of ['credits', 'models', 'privacy', 'roles', 'support', 'branding', 'wording'])
      expect(keys).not.toContain(key);
    expect(res.body.find((s: { key: string }) => s.key === 'shares')).toEqual({
      key: 'shares',
      capability: 'settings.manage',
      value: { defaultDays: 7, maxDays: 90, sessionHours: 12 },
      problems: [],
    });
    expect((await read(owner, 'general')).body.value).toEqual({
      timeZone: expect.any(String),
      quietHours: { from: expect.any(String), to: expect.any(String) },
      replyTime: expect.any(String),
      marketingPerWeek: expect.any(Number),
    });
  });

  it('a section with its own capability is listed only for its holders; staff see none', async () => {
    const adminKeys = (await admin.call('GET', '/api/settings/sections', undefined, inTenant()))
      .body as { key: string }[];
    expect(adminKeys.map((s) => s.key)).toContain('approvals');
    expect(adminKeys.map((s) => s.key)).not.toContain('fixtureClaims');
    expect((await read(admin, 'fixtureClaims')).status).toBe(403);
    expect((await staff.call('GET', '/api/settings/sections', undefined, inTenant())).body).toEqual(
      [],
    );
    expect((await read(staff, 'approvals')).body).toMatchObject({
      rule: 'needs_settings_manage',
    });
    expect((await read(owner, 'credits')).status).toBe(404);
    expect((await read(owner, 'nothing')).status).toBe(404);
  });
});

describe('who may change them', () => {
  it('staff are refused, and the refusal is audited; the assistant is refused too', async () => {
    const refused = await patch(staff, 'files', { keepInboundMedia: false });
    expect(refused.status).toBe(403);
    expect(refused.body).toMatchObject({ rule: 'needs_settings_manage' });
    expect(await audit()).toContainEqual(
      expect.objectContaining({ outcome: 'denied', rule: 'needs_settings_manage' }),
    );
    const assistant = asAssistant(`user:${owner.id}`);
    expect(
      (
        await assistant('PATCH', '/api/settings/sections/files', {
          value: { keepInboundMedia: false },
        })
      ).status,
    ).toBe(403);
    expect((await stored()).files).toBeUndefined();
  });

  it('another business never changes this one: it names it and is refused, its own stays its own', async () => {
    const before = await stored();
    const across = await patch(other, 'files', { keepInboundMedia: false }, inTenant());
    expect(across.status).toBe(403);
    expect(across.body).toMatchObject({ rule: 'not_a_member' });
    expect(
      (await other.call('GET', '/api/settings/sections/files', undefined, inTenant())).status,
    ).toBe(403);
    const own = await patch(other, 'files', { keepInboundMedia: false });
    expect(own.body).toMatchObject({ status: 'done', value: { key: 'files' } });
    expect((await stored(otherTenant)).files).toEqual({ keepInboundMedia: false });
    expect(await stored()).toEqual(before);
    expect((await read(owner, 'files')).body.value).toEqual({ keepInboundMedia: true });
  });

  it("a module's own section is changed by its own capability, and checked by its own check", async () => {
    const refused = await patch(admin, 'fixtureClaims', { maxOpen: 5 });
    expect(refused.status).toBe(403);
    expect(refused.body).toMatchObject({ rule: 'needs_fixture_claims_setup' });
    const set = await patch(owner, 'fixtureClaims', { maxOpen: 5, heading: 'Claims' });
    expect(set.body).toMatchObject({
      status: 'done',
      value: { key: 'fixtureClaims', value: { maxOpen: 5, heading: 'Claims' } },
    });
    await setThreshold(eur(1_000_00));
    for (const amount of [10_00, 20_00]) expect((await claim(owner, amount)).status).toBe(201);
    expect(problemsOf(await patch(owner, 'fixtureClaims', { maxOpen: 1 }))).toEqual([
      expect.stringMatching(/^fixtureClaims\.maxOpen: \d+ claims are open already$/),
    ]);
  });
});

async function setThreshold(limit: { minor: number; currency: string } | null) {
  const res = await patch(owner, 'approvals', { thresholds: { 'claims.limit': limit } });
  expect(res.body).toMatchObject({ status: 'done' });
  return res;
}

describe('a change through the write path', () => {
  it('a merge patch: one key beside the others, null restores a default; stored as set', async () => {
    const first = await patch(owner, 'approvals', { thresholds: { 'claims.other': eur(5_00) } });
    expect(first.status).toBe(200);
    expect(first.body.value.value).toMatchObject({
      levels: {},
      bands: {},
      thresholds: { 'claims.other': eur(5_00) },
    });
    const second = await patch(owner, 'approvals', {
      thresholds: { 'claims.second': eur(7_00) },
    });
    expect(second.body.value.value.thresholds).toMatchObject({
      'claims.other': eur(5_00),
      'claims.second': eur(7_00),
    });
    await patch(owner, 'approvals', { thresholds: { 'claims.other': null } });
    const after = (await stored()).approvals;
    // What the business set, without the defaults it never touched.
    expect(after.levels).toBeUndefined();
    expect(after.thresholds['claims.other']).toBeUndefined();
    expect(after.thresholds['claims.second']).toEqual(eur(7_00));

    await patch(owner, 'memory', { limit: 3, minScore: 0.5 });
    const reset = await patch(owner, 'memory', { limit: null });
    expect(reset.body.value.value).toEqual({
      recall: true,
      conversation: true,
      limit: 5,
      minScore: 0.5,
    });
    expect((await stored()).memory).toEqual({ minScore: 0.5 });
  });

  it('audits the section before and after, and announces settings.changed', async () => {
    const res = await patch(owner, 'parties', { unknownSenders: 'contact' });
    expect(res.body).toMatchObject({
      status: 'done',
      value: { key: 'parties', value: { unknownSenders: 'contact' } },
    });
    expect(await audit()).toContainEqual(
      expect.objectContaining({ outcome: 'committed', actor_kind: 'user' }),
    );
    expect(await changes()).toContainEqual({
      before: { parties: null },
      after: { parties: { unknownSenders: 'contact' } },
    });
    const { rows } = await pool.query(
      `select "row" from app.domain_events where name = 'settings.changed' and resource_id = $1`,
      [tenantId],
    );
    expect(rows.map((r) => r.row.section)).toContain('parties');
    await patch(owner, 'parties', { unknownSenders: null });
  });

  it('the process drops its cached copy at once', async () => {
    expect((await config().section(tenantId, 'shares')).defaultDays).toBe(7);
    await patch(owner, 'shares', { defaultDays: 14, maxDays: 30 });
    expect(await config().section(tenantId, 'shares')).toEqual({
      defaultDays: 14,
      maxDays: 30,
      sessionHours: 12,
    });
    const general = (await config().get(tenantId)).settings;
    await patch(owner, 'general', { quietHours: { from: '22:30' }, replyTime: '1 day' });
    expect((await config().get(tenantId)).settings).toMatchObject({
      quietHours: { from: '22:30', to: general.quietHours.to },
      replyTime: '1 day',
    });
    await patch(owner, 'general', { quietHours: null, replyTime: null });
    expect((await stored()).quietHours).toBeUndefined();
  });

  it('refuses unknown keys, anywhere in the patch, rather than dropping them', async () => {
    expect(problemsOf(await patch(owner, 'shares', { defaultDays: 3, lifetime: 9 }))).toEqual([
      'shares.lifetime: not a setting',
    ]);
    expect(
      problemsOf(
        await patch(owner, 'approvals', {
          levels: { fixture_claims_large: { expiresInMs: 600_000, after: 1 } },
        }),
      ),
    ).toEqual(['approvals.levels.fixture_claims_large.after: not a setting']);
    expect(problemsOf(await patch(owner, 'general', { grievanceContact: 'x' }))).toEqual([
      'general.grievanceContact: not a setting',
    ]);
    expect(problemsOf(await patch(owner, 'files', { constructor: { x: 1 } }))).toEqual([
      'files.constructor: not a setting',
    ]);
  });

  it('refuses values the schema refuses, and what only the checks can see', async () => {
    const bad = async (section: string, value: unknown, problem: RegExp) =>
      expect(problemsOf(await patch(owner, section, value))).toEqual(
        expect.arrayContaining([expect.stringMatching(problem)]),
      );
    await bad('shares', { maxDays: 0 }, /^shares\.maxDays: /);
    await bad('shares', { defaultDays: 60, maxDays: 30 }, /^shares\.defaultDays: at most maxDays/);
    await bad('money', { fyStartMonth: 13 }, /^money\.fyStartMonth: /);
    await bad('money', { currency: 'ABC' }, /^money\.currency: "ABC" is not a currency/);
    await bad(
      'money',
      { bands: { orders: [eur(100_00), eur(50_00)] } },
      /^money\.bands\.orders\[1\]: each bound is above/,
    );
    await bad(
      'approvals',
      { levels: { nobody_declares: { parks: true } } },
      /^approvals\.levels\.nobody_declares: no approval level/,
    );
    await bad(
      'approvals',
      { levels: { fixture_claims_large: { parks: false } } },
      /^approvals\.levels\.fixture_claims_large\.parks: this level always waits/,
    );
    await bad(
      'approvals',
      { bands: { claims: [{ approver: { capability: 'fixture.nobody.has' } }] } },
      /^approvals\.bands\.claims\[0\]\.approver: nobody defines the capability/,
    );
    await bad(
      'approvals',
      { bands: { claims: [{ approver: { userId: other.id } }] } },
      /^approvals\.bands\.claims\[0\]\.approver: ".+" is not on this business's team/,
    );
    await bad(
      'approvals',
      {
        bands: {
          claims: [
            { approver: { capability: 'fixture.claims.approve' } },
            { upTo: eur(10_00), approver: { userId: admin.id } },
          ],
        },
      },
      /^approvals\.bands\.claims\[1\]: no amount reaches this band/,
    );
    await bad(
      'businessHours',
      { week: { mon: [{ from: '09:00', to: '25:00' }] } },
      /^businessHours\.week\.mon\.0\.to: /,
    );
    await bad(
      'businessHours',
      {
        week: {
          mon: [
            { from: '09:00', to: '13:00' },
            { from: '12:00', to: '17:00' },
          ],
        },
      },
      /^businessHours\.week\.mon: open intervals overlap/,
    );
    await bad('businessHours', { holidays: ['2026-13-01'] }, /^businessHours\.holidays\.0: /);
    await bad(
      'sla',
      { within: { 'fixture.claims.answr': '2h' } },
      /^sla\.within\.fixture\.claims\.answr: no SLA/,
    );
    await bad(
      'sla',
      { within: { 'fixture.claims.answer': 'soon' } },
      /^sla\.within\.fixture\.claims\.answer: /,
    );
    await bad('sla', { off: ['fixture.nothing'] }, /^sla\.off: no SLA is called "fixture.nothing"/);
    await bad(
      'general',
      { timeZone: 'Mars/Olympus' },
      /^general\.timeZone: "Mars\/Olympus" is not a time zone/,
    );
    await bad('general', { quietHours: { from: '9pm' } }, /^general\.quietHours\.from: /);
    await bad('general', { marketingPerWeek: -1 }, /^general\.marketingPerWeek: /);
    // Nothing was kept.
    const s = await stored();
    expect(s.businessHours).toBeUndefined();
    expect(s.sla).toBeUndefined();
    expect(s.timeZone).toBeUndefined();
    // Not changed here: their own feature changes them.
    for (const section of ['credits', 'models', 'privacy', 'roles', 'branding', 'nothing'])
      expect((await patch(owner, section, {})).status).toBe(404);
  });
});

describe('a change takes effect on the next write', () => {
  it('a new threshold: what waited now runs, and above it, still waits', async () => {
    await setThreshold(null);
    const unlimited = await claim(owner, 50_00);
    expect(unlimited.body).toMatchObject({
      status: 'needs_approval',
      approval: { rule: 'claim_over_limit' },
    });
    await setThreshold(eur(100_00));
    const within = await claim(owner, 50_00);
    expect(within.status).toBe(201);
    expect(within.body).toMatchObject({ status: 'done', value: { amountMinor: 50_00 } });
    const above = await claim(owner, 500_00);
    expect(above.body).toMatchObject({
      status: 'needs_approval',
      approval: { decider: { by: 'capability', capability: 'approvals.decide' } },
    });
    // Another currency fails closed: it waits.
    expect((await claim(owner, 1_00, 'USD')).body).toMatchObject({ status: 'needs_approval' });
  });

  it("a new band approver, which the application's rule makes wait for a second person", async () => {
    const asked = await patch(owner, 'approvals', {
      bands: {
        claims: [
          { upTo: eur(1_000_00), approver: { userId: admin.id } },
          { approver: { capability: 'fixture.claims.approve' } },
        ],
      },
    });
    expect(asked.body).toMatchObject({
      status: 'needs_approval',
      approval: { rule: 'approvers_change' },
    });
    const { id } = asked.body.approval;
    expect(await audit()).toContainEqual(expect.objectContaining({ outcome: 'needs_approval' }));
    expect((await stored()).approvals.bands).toBeUndefined();
    // The owner asked: someone else decides; then the change runs, checked again.
    expect((await owner.call('POST', `/api/approvals/${id}/approve`)).body).toMatchObject({
      rule: 'own_request',
    });
    const decided = await ops.call('POST', `/api/approvals/${id}/approve`, undefined, inTenant());
    expect(decided.body).toMatchObject({ status: 'approved' });
    expect((await stored()).approvals.bands.claims).toHaveLength(2);
    expect(await audit()).toContainEqual(
      expect.objectContaining({ outcome: 'committed', rule: 'approved:approvers_change' }),
    );
    expect((await changes()).at(-1)?.after.approvals.bands.claims).toHaveLength(2);

    const named = await claim(owner, 500_00);
    expect(named.body.approval).toMatchObject({ decider: { by: 'person', userId: admin.id } });
    const big = await claim(owner, 5_000_00);
    expect(big.body.approval).toMatchObject({
      decider: { by: 'capability', capability: 'fixture.claims.approve' },
    });
  });

  it('a new SLA duration, a switched-off SLA and business hours set the next timers', async () => {
    const zone = await patch(owner, 'general', { timeZone: 'UTC' });
    expect(zone.body).toMatchObject({ status: 'done', value: { value: { timeZone: 'UTC' } } });
    const week = { mon: [{ from: '09:00', to: '17:00' }], wed: [{ from: '09:00', to: '12:00' }] };
    const hours = await patch(owner, 'businessHours', { week, holidays: ['2026-12-25'] });
    expect(hours.body).toMatchObject({ status: 'done' });
    expect(
      (await patch(owner, 'sla', { within: { 'fixture.claims.answer': '3h' } })).body,
    ).toMatchObject({
      status: 'done',
      value: { value: { within: { 'fixture.claims.answer': '3h' } } },
    });

    const made = (await claim(owner, 10_00)).body.value as Claim;
    const list = await timers(made.id);
    const answer = list.find((t) => t.sla === 'fixture.claims.answer') as SlaTimer;
    const review = list.find((t) => t.sla === 'fixture.claims.review') as SlaTimer;
    expect(Date.parse(answer.dueAt) - Date.parse(answer.startedAt)).toBe(3 * 3_600_000);
    const due = addBusinessTime(
      new Date(review.startedAt),
      2 * 3_600_000,
      openHoursOf({ week, holidays: ['2026-12-25'] }),
      'UTC',
    );
    expect(review.dueAt).toBe(due.toISOString());

    // A day shorter: the next claim's review is due later than it would have been.
    await patch(owner, 'businessHours', { week: { mon: [{ from: '09:00', to: '10:00' }] } });
    const next = (await claim(owner, 10_00)).body.value as Claim;
    const nextReview = (await timers(next.id)).find(
      (t) => t.sla === 'fixture.claims.review',
    ) as SlaTimer;
    expect(nextReview.dueAt).toBe(
      addBusinessTime(
        new Date(nextReview.startedAt),
        2 * 3_600_000,
        openHoursOf({
          week: { mon: [{ from: '09:00', to: '10:00' }], wed: [{ from: '09:00', to: '12:00' }] },
          holidays: ['2026-12-25'],
        }),
        'UTC',
      ).toISOString(),
    );

    await patch(owner, 'sla', { off: ['fixture.claims.review'], within: null });
    const quiet = (await claim(owner, 10_00)).body.value as Claim;
    const left = await timers(quiet.id);
    expect(left.map((t) => t.sla)).toEqual(['fixture.claims.answer']);
    expect(Date.parse(left[0].dueAt) - Date.parse(left[0].startedAt)).toBe(3_600_000);
  });
});
