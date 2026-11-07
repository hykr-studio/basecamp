// Personal data declarations, without a server (B18): the privacy trait's checks on its own and
// against its table, the application's policy, processors, targets and periods, how a
// business's settings and the application's policy combine, and what erasure leaves of a filing.
import { entitySpec, parseTenantSettings, privacyTraitProblems } from '@hykr/contracts';
import { defineEntity, registerEntityDef } from '@hykr/core';
import { app, customerColumn, id, tenantColumn, user } from '@hykr/db';
import { text, timestamp } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { scrubFiling } from '../../dist/features/privacy/redact.js';
import { registryProblems } from '../../dist/features/privacy/registry.js';
import { dueFrom, effectivePolicy } from '../../dist/features/privacy/requests.js';
import {
  definePrivacyPolicy,
  defineProcessor,
  personalEntityProblems,
  privacyPolicies,
  retentionPeriods,
} from '../../dist/index.js';

const label = (en: string) => ({ en, hi: en, te: en });

describe('the privacy trait on its own', () => {
  it('needs a subject column, a field, a reason to keep and whole days', () => {
    expect(
      privacyTraitProblems('thing', {
        subject: {},
        fields: [],
        erase: 'keep',
        replace: { other: 1 },
        retention: { name: 'Bad Name', days: 1.5, action: 'delete' },
      }),
    ).toEqual([
      'Entity thing, trait privacy: name at least one subject column (user, customer or contact)',
      'Entity thing, trait privacy: name at least one personal field',
      "Entity thing, trait privacy: erase 'keep' needs a keepReason",
      'Entity thing, trait privacy: replace names "other", which is not one of its fields',
      'Entity thing, trait privacy: retention name "Bad Name" must be lower case words joined by "."',
      'Entity thing, trait privacy: retention days must be a whole number of days, at least 1',
    ]);
    expect(
      privacyTraitProblems('thing', {
        subject: { customer: ['customerId'] },
        fields: ['name'],
        erase: 'delete',
        retention: { name: 'things.personal', days: 30, action: 'delete' },
      }),
    ).toEqual([]);
  });
});

describe('the privacy trait against its table', () => {
  it('names columns the table has, and can blank what it anonymises', () => {
    const table = app.table('privacy_unit_things', {
      id: id(),
      tenantId: tenantColumn(),
      ownerId: text('owner_id')
        .notNull()
        .references(() => user.id),
      customerId: customerColumn(),
      title: text('title').notNull(),
      body: text('body').notNull().default(''),
      note: text('note'),
      createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    });
    const spec = entitySpec({
      name: 'privacyUnitThing',
      label: 'thing',
      description: 'Things.',
      schemas: {
        read: z.object({ id: z.string(), title: z.string() }),
        create: z.object({ title: z.string() }),
        update: z.object({ title: z.string() }),
      },
      list: {
        filterable: {},
        sortable: ['createdAt'],
        defaultSort: [['createdAt', 'asc']],
        pageSize: { default: 10, max: 10 },
      },
      traits: {
        privacy: {
          subject: { customer: ['customerId'], contact: ['contactId'] },
          fields: ['title', 'body', 'note', 'missing'],
          erase: 'anonymise',
          retention: { name: 'things.personal', days: 10, from: 'title', action: 'delete' },
        },
      },
    });
    registerEntityDef(
      defineEntity(spec, { table, owner: (t) => t.ownerId, customer: (t) => t.customerId }),
    );
    expect(personalEntityProblems()).toEqual([
      'Entity privacyUnitThing, trait privacy: subject column "contactId" is not in its table',
      'Entity privacyUnitThing, trait privacy: "title" cannot be empty (NOT NULL): give replace.title',
      'Entity privacyUnitThing, trait privacy: field "missing" is not in its table',
      'Entity privacyUnitThing, trait privacy: retention counts from "title", not a date',
    ]);
  });
});

describe("the application's declarations", () => {
  it('checks processors and policies when they are declared', () => {
    expect(() => defineProcessor({ name: ' ', purpose: label('x') })).toThrow('needs a name');
    expect(() => defineProcessor({ name: 'Mail', purpose: label(' ') })).toThrow('purpose');
    expect(() => definePrivacyPolicy({ name: 'app', respondWithinDays: 0 })).toThrow(
      '1 to 365 whole days',
    );
    expect(definePrivacyPolicy({ name: 'app', respondWithinDays: 30 }).respondWithinDays).toBe(30);
  });

  it('refuses a second policy, and a period for no target', () => {
    privacyPolicies.register({ name: 'one' }, { name: 'two' });
    retentionPeriods.register({ target: 'nothing.here', days: 0 });
    expect(registryProblems()).toEqual([
      'Only one privacy policy may be contributed; found one, two',
      'Retention period for "nothing.here": no retention target has that name',
      'Retention period for nothing.here: days must be whole days, at least 1',
    ]);
  });

  it("combines the business's settings with the application's policy", () => {
    // `one` is the policy now (the first registered); it names no deadline.
    const settings = parseTenantSettings({ privacy: { review: ['erase'] } });
    expect(effectivePolicy(settings)).toEqual({ respondWithinDays: null, review: ['erase'] });
    const own = parseTenantSettings({ privacy: { respondWithinDays: 7 } });
    expect(effectivePolicy(own).respondWithinDays).toBe(7);
    const at = new Date('2030-01-01T00:00:00Z');
    expect(dueFrom(at, 7)?.toISOString()).toBe('2030-01-08T00:00:00.000Z');
    expect(dueFrom(at, null)).toBeNull();
  });
});

describe('a privacy filing about an erased person', () => {
  const about = {
    userId: 'u1',
    emails: ['asha@example.test'],
    contacts: [{ id: 'c1', address: '919800000001' }],
    requestIds: [],
  };

  it('names them by id instead of the email or number, without its note', () => {
    expect(
      scrubFiling({ kind: 'erase', for: { email: ' Asha@Example.test ' }, note: 'x' }, about),
    ).toEqual({ kind: 'erase', for: { userId: 'u1' } });
    expect(scrubFiling({ kind: 'erase', for: { address: '+919800000001' } }, about)).toEqual({
      kind: 'erase',
      for: { contactId: 'c1' },
    });
    expect(scrubFiling({ kind: 'export', for: { userId: 'u1' }, note: 'x' }, about)).toEqual({
      kind: 'export',
      for: { userId: 'u1' },
    });
    // Filed by them for themselves.
    expect(scrubFiling({ kind: 'export', note: 'mine' }, about, { userId: 'u1' })).toEqual({
      kind: 'export',
    });
    expect(scrubFiling({ kind: 'export', note: 'mine' }, about, { contactId: 'c1' })).toEqual({
      kind: 'export',
    });
  });

  it('leaves a filing about someone else, or one with nothing to take out, as it is', () => {
    expect(
      scrubFiling({ kind: 'erase', for: { email: 'bala@example.test' }, note: 'x' }, about),
    ).toBeNull();
    expect(scrubFiling({ kind: 'erase', for: { address: '919800000002' } }, about)).toBeNull();
    expect(scrubFiling({ kind: 'erase', note: 'x' }, about, { userId: 'u2' })).toBeNull();
    expect(scrubFiling({ kind: 'erase', for: { userId: 'u1' } }, about)).toBeNull();
    expect(scrubFiling('not an input', about)).toBeNull();
    // An email is an account's: a contact alone is not named by one.
    expect(
      scrubFiling(
        { kind: 'erase', for: { email: 'asha@example.test' } },
        { ...about, userId: null },
      ),
    ).toBeNull();
  });
});
