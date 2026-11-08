// Neutral business defaults (docs/decisions/X2.md): a business that set no time zone follows the
// deployment's (DEFAULT_TIME_ZONE), else UTC, and sets its own with PUT /api/settings/time-zone
// (settings.manage, people only, audited, only in its own business); a business that named no
// privacy contact shows the deployment's (DEFAULT_GRIEVANCE_CONTACT), else none at all.
import { defaultTimeZone, setDefaultTimeZone } from '@hykr/core';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  addMember,
  asAssistant,
  boot,
  me,
  Person,
  pool,
  setTenantSettings,
  shutdown,
} from '../../dist/testing.js';
import { fixture } from '../fixture/dist/index.js';

const owner = new Person('Owner Defaults');
const staff = new Person('Staff Defaults');
const other = new Person('Other Defaults');
let tenantId = '';
let otherTenant = '';
let setContact: (contact: string | undefined) => void = () => {};
let deploymentContact: () => string | undefined = () => undefined;
const zoneWas = { value: 'UTC' };
const contactWas: { value: string | undefined } = { value: undefined };

const here = { 'x-tenant-id': '' };
const zoneOf = async (p: Person, headers: Record<string, string> = {}) =>
  (await p.call('GET', '/api/money', undefined, headers)).body.timeZone as string;
const stored = async (id: string) =>
  (await pool.query('select settings from app.tenants where id = $1', [id])).rows[0].settings;
/** The command's rows and the business's own change (its before and after) it audited. */
const audit = async (tenant: string) =>
  (
    await pool.query(
      `select action, outcome, rule, actor_kind, before, after from audit.events
       where action in ('settings.timeZone', 'tenant.update') and tenant_id = $1 order by at`,
      [tenant],
    )
  ).rows;
/** The UTC hour and minute an instant falls on. */
const utcClock = (iso: string) => {
  const d = new Date(iso);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
};

beforeAll(async () => {
  await boot(fixture);
  for (const p of [owner, staff, other]) await p.signUp();
  tenantId = (await me(owner)).tenantId;
  otherTenant = (await me(other)).tenantId;
  here['x-tenant-id'] = tenantId;
  await addMember(staff, tenantId, ['staff']);
  // Loaded after boot: it reads the server's configuration.
  const internals = await import('../../dist/testing-internals.js');
  setContact = internals.setDefaultGrievanceContact;
  deploymentContact = internals.defaultGrievanceContact;
  zoneWas.value = defaultTimeZone();
  contactWas.value = deploymentContact();
});
// The deployment's defaults as the .env had them: other files see what they expect.
afterEach(() => {
  setDefaultTimeZone(zoneWas.value === 'UTC' ? undefined : zoneWas.value);
  setContact(contactWas.value);
});
afterAll(shutdown);

describe("a business's time zone", () => {
  it("is the deployment's while the business sets none, else UTC", async () => {
    await setTenantSettings(tenantId, { timeZone: null });
    setDefaultTimeZone(undefined);
    expect(await zoneOf(owner)).toBe('UTC');
    setDefaultTimeZone('Asia/Tokyo');
    expect(await zoneOf(owner)).toBe('Asia/Tokyo');
    // A stored value that is not a zone is ignored, not an error.
    await setTenantSettings(tenantId, { timeZone: 'Mars/Olympus' });
    expect(await zoneOf(owner)).toBe('Asia/Tokyo');
    await setTenantSettings(tenantId, { timeZone: 'Europe/Berlin' });
    expect(await zoneOf(owner)).toBe('Europe/Berlin');
    await setTenantSettings(tenantId, { timeZone: null });
  });

  it("starts the credit period at the business's midnight", async () => {
    // Zones without summer time: the period starts at the same UTC clock in every month.
    await setTenantSettings(tenantId, { timeZone: null });
    setDefaultTimeZone('Asia/Tokyo');
    const tokyo = (await owner.call('GET', '/api/credits')).body.period;
    expect(utcClock(tokyo.start)).toBe('15:00');
    await setTenantSettings(tenantId, { timeZone: 'Pacific/Honolulu' });
    const honolulu = (await owner.call('GET', '/api/credits')).body.period;
    expect(utcClock(honolulu.start)).toBe('10:00');
    await setTenantSettings(tenantId, { timeZone: null });
    setDefaultTimeZone(undefined);
    expect(utcClock((await owner.call('GET', '/api/credits')).body.period.start)).toBe('00:00');
  });
});

describe('PUT /api/settings/time-zone', () => {
  it("sets the business's own zone, audited, and null goes back to the deployment's", async () => {
    setDefaultTimeZone('Asia/Tokyo');
    const set = await owner.call('PUT', '/api/settings/time-zone', {
      timeZone: 'America/Sao_Paulo',
    });
    expect(set.status).toBe(200);
    expect(set.body.value).toEqual({
      timeZone: 'America/Sao_Paulo',
      effective: 'America/Sao_Paulo',
    });
    expect(await zoneOf(owner)).toBe('America/Sao_Paulo');
    expect(await zoneOf(staff, here)).toBe('America/Sao_Paulo');
    expect((await stored(tenantId)).timeZone).toBe('America/Sao_Paulo');

    const cleared = await owner.call('PUT', '/api/settings/time-zone', { timeZone: null });
    expect(cleared.body.value).toEqual({ timeZone: null, effective: 'Asia/Tokyo' });
    expect(await stored(tenantId)).not.toHaveProperty('timeZone');
    expect(await zoneOf(owner)).toBe('Asia/Tokyo');

    const rows = await audit(tenantId);
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: 'settings.timeZone',
          outcome: 'committed',
          actor_kind: 'user',
          rule: 'settings_manager',
        }),
        expect.objectContaining({
          action: 'tenant.update',
          before: { timeZone: null },
          after: { timeZone: 'America/Sao_Paulo' },
        }),
        expect.objectContaining({
          action: 'tenant.update',
          before: { timeZone: 'America/Sao_Paulo' },
          after: { timeZone: null },
        }),
      ]),
    );
  });

  it('refuses a name that is not a zone, and changes nothing', async () => {
    await setTenantSettings(tenantId, { timeZone: 'Europe/Berlin' });
    const bad = await owner.call('PUT', '/api/settings/time-zone', { timeZone: 'Mars/Olympus' });
    expect(bad.status).toBe(400);
    expect(bad.body).toMatchObject({ error: 'time_zone_invalid' });
    const empty = await owner.call('PUT', '/api/settings/time-zone', { timeZone: '' });
    expect(empty.status).toBe(400);
    expect((await stored(tenantId)).timeZone).toBe('Europe/Berlin');
    await setTenantSettings(tenantId, { timeZone: null });
  });

  it('needs settings.manage, and a person: staff and the assistant are refused', async () => {
    await setTenantSettings(tenantId, { timeZone: 'Europe/Berlin' });
    const refused = await staff.call(
      'PUT',
      '/api/settings/time-zone',
      { timeZone: 'Asia/Tokyo' },
      here,
    );
    expect(refused.status).toBe(403);
    expect(refused.body).toMatchObject({ rule: 'needs_settings_manage' });
    expect(await audit(tenantId)).toContainEqual(
      expect.objectContaining({
        action: 'settings.timeZone',
        outcome: 'denied',
        rule: 'needs_settings_manage',
      }),
    );
    const assistant = asAssistant(`user:${owner.id}`, here);
    const byAgent = await assistant('PUT', '/api/settings/time-zone', { timeZone: 'Asia/Tokyo' });
    expect(byAgent.status).toBe(403);
    expect(byAgent.body).toMatchObject({ rule: 'humans_only' });
    expect((await stored(tenantId)).timeZone).toBe('Europe/Berlin');
    await setTenantSettings(tenantId, { timeZone: null });
  });

  it('reaches only its own business', async () => {
    await setTenantSettings(tenantId, { timeZone: 'Europe/Berlin' });
    // Another business's owner, naming this business: not theirs.
    const across = await other.call('PUT', '/api/settings/time-zone', { timeZone: 'UTC' }, here);
    expect(across.status).not.toBe(200);
    expect((await stored(tenantId)).timeZone).toBe('Europe/Berlin');
    // Their own: theirs changes, this one does not.
    const theirs = await other.call('PUT', '/api/settings/time-zone', {
      timeZone: 'Asia/Kathmandu',
    });
    expect(theirs.status).toBe(200);
    expect((await stored(otherTenant)).timeZone).toBe('Asia/Kathmandu');
    expect((await stored(tenantId)).timeZone).toBe('Europe/Berlin');
    expect(await zoneOf(owner)).toBe('Europe/Berlin');
    await setTenantSettings(tenantId, { timeZone: null });
    await setTenantSettings(otherTenant, { timeZone: null });
  });
});

describe("a business's privacy contact", () => {
  const register = async (p: Person) =>
    (await p.call('GET', '/api/privacy/register')).body.fiduciary.grievanceContact;
  const configured = async (p: Person) =>
    (await p.call('GET', '/api/privacy/settings')).body.grievanceContact;

  it('is none at all while neither the business nor the deployment names one', async () => {
    await setTenantSettings(tenantId, { grievanceContact: null });
    setContact(undefined);
    expect(await register(owner)).toBeNull();
    expect(await configured(owner)).toBeNull();
    // Nobody else's contact shows either: another business's own stays its own.
    await setTenantSettings(otherTenant, { grievanceContact: 'dpo@other.test' });
    expect(await register(owner)).toBeNull();
    expect(await register(other)).toBe('dpo@other.test');
    await setTenantSettings(otherTenant, { grievanceContact: null });
  });

  it("is the deployment's while the business names none, and the business's own after", async () => {
    await setTenantSettings(tenantId, { grievanceContact: null });
    setContact('privacy@deployment.test');
    expect(await register(owner)).toBe('privacy@deployment.test');
    expect(await register(staff)).toBe('privacy@deployment.test');
    const own = await owner.call('PATCH', '/api/privacy/settings', {
      grievanceContact: 'dpo@owner.test',
    });
    expect(own.status).toBe(200);
    expect(own.body.value.grievanceContact).toBe('dpo@owner.test');
    expect(await register(owner)).toBe('dpo@owner.test');
    // Back to none of its own: the deployment's again.
    const back = await owner.call('PATCH', '/api/privacy/settings', { grievanceContact: null });
    expect(back.body.value.grievanceContact).toBe('privacy@deployment.test');
    expect(await stored(tenantId)).not.toHaveProperty('grievanceContact');
  });
});
