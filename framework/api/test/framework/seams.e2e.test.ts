// The framework's extension points (F0): every kind of contribution reaches its registry when
// the app starts, and the app serves exactly as before. Settings sections, traits and event
// envelopes are checked here too, with the fixture's own declarations (fixture/src/features/seams).
import {
  createHookRegistry,
  DomainEventEnvelope,
  defineSettingsSection,
  installContributions,
  mergeContributions,
  type Principal,
  parseTenantSettings,
} from '@hykr/contracts';
import { TenantConfigService } from '@hykr/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { TenantsService } from '../../dist/channels/tenants.service.js';
import * as api from '../../dist/index.js';
import { boot, me, Person, pool, server, shutdown } from '../../dist/testing.js';
import { TaskSpec } from '../fixture/dist/contracts.js';
import {
  NotedSpec,
  NoteItSpec,
  seams,
  seamsContributions,
} from '../fixture/dist/features/seams/index.js';

const ana = new Person('Ana Seams');
const NAME = 'fixture.seams';

/** Each contribution key and the registry that collects it. */
const registries = {
  entityPlugins: api.entityPlugins,
  writeHooks: api.writeHooks,
  readProjectors: api.readProjectors,
  identityProviders: api.identityProviders,
  toolContributions: api.toolContributions,
  deliveryChannels: api.deliveryChannels,
  turnHooks: api.turnHooks,
  inboundHooks: api.inboundHooks,
  queues: api.queues,
  schedules: api.schedules,
  erasureContributors: api.erasureContributors,
  exportContributors: api.exportContributors,
  authPlugins: api.authPlugins,
} as const;

beforeAll(async () => {
  await boot(seams);
  await ana.signUp();
});
afterAll(shutdown);

describe('contributions', () => {
  it('each one lands in the registry for its kind when the app starts', () => {
    expect(Object.keys(registries).sort()).toEqual(Object.keys(seamsContributions).sort());
    for (const [key, registry] of Object.entries(registries)) {
      const [contributed] = seamsContributions[key as keyof typeof registries] ?? [];
      expect(registry.get(NAME), key).toBe(contributed);
      // The framework's features register their own too (the channel's queues, the events
      // queue, the files hooks, money's entity plugins `parent` and `money`, the push channel,
      // its schedule and contributors, the members feature's entity plugin, write hook and read
      // projector): the application's is the only fixture one.
      expect(registry.all(), key).toContain(contributed);
      const fixtures = (registry.all() as readonly { name: string }[]).filter((x) =>
        x.name.startsWith('fixture.'),
      );
      expect(fixtures, key).toEqual([contributed]);
    }
    expect(api.runtime().contributions).toEqual(seamsContributions);
  });

  it('the app serves as before with them installed', async () => {
    const created = await ana.call('POST', '/api/tasks', { title: 'Order paper' });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ status: 'done', value: { title: 'Order paper' } });
    const list = await ana.call('GET', '/api/tasks');
    expect(list.body.items.map((t: { title: string }) => t.title)).toEqual(['Order paper']);
  });

  it('a name is unique in its registry', () => {
    expect(() => api.turnHooks.register({ name: NAME })).toThrow(
      'The turn hook "fixture.seams" is registered twice',
    );
    expect(api.turnHooks.all()).toHaveLength(1);
  });

  it('a key that nothing collects fails closed, before anything is registered', () => {
    const bad = { turnHooks: [{ name: 'fixture.other' }], noSuchKind: [{ name: 'x' }] };
    expect(() => installContributions(bad as never)).toThrow(
      'Nothing collects the contribution "noSuchKind"',
    );
    expect(api.turnHooks.has('fixture.other')).toBe(false);
  });

  it('one key has one collector', () => {
    expect(() => createHookRegistry('turn hook', () => 'x', { collects: 'turnHooks' })).toThrow(
      'Contributions "turnHooks" are already collected by turn hook',
    );
  });

  it('sets of contributions merge in order', () => {
    const a = { name: 'a' };
    const b = { name: 'b' };
    const q = { name: 'q' };
    expect(
      mergeContributions({ turnHooks: [a] }, undefined, { turnHooks: [b], queues: [q] }),
    ).toEqual({ turnHooks: [a, b], queues: [q] });
  });

  it('read projectors run on every record that leaves the server', () => {
    const p = { actor: { kind: 'user', id: ana.id, role: 'owner' }, scopes: [] } as Principal;
    expect(api.projectRead('task', { id: '1', secret: 'cost' }, p)).toEqual({ id: '1' });
    expect(api.projectRead('visit', { id: '1', secret: 'x' }, p)).toEqual({ id: '1', secret: 'x' });
  });

  it('traits survive the spec builders, and a plugin finds the specs that carry its own', () => {
    const [plugin] = seamsContributions.entityPlugins ?? [];
    expect(NotedSpec.traits).toEqual({ fixtureNoted: { note: 'kept' } });
    expect(NoteItSpec.traits).toEqual({ fixtureNoted: { note: 'kept' } });
    expect(plugin.appliesTo?.(NotedSpec)).toBe(true);
    expect(plugin.appliesTo?.(TaskSpec)).toBe(false);
  });
});

describe('tenant settings', () => {
  it('base settings, features and sections all have defaults', () => {
    const settings = parseTenantSettings(undefined);
    expect(settings).toMatchObject({
      timeZone: 'Asia/Kolkata',
      features: {},
      fixtureSeams: { limit: 5 },
    });
  });

  it('stored values win; invalid ones throw', () => {
    const settings = parseTenantSettings({ fixtureSeams: { limit: 9 }, features: { beta: true } });
    expect(settings.fixtureSeams.limit).toBe(9);
    expect(settings.features).toEqual({ beta: true });
    expect(() => parseTenantSettings({ fixtureSeams: { limit: -1 } })).toThrow();
  });

  it("a business's settings include its sections", async () => {
    const tenants = server.app?.get(TenantsService, { strict: false });
    const { tenantId } = await me(ana);
    expect((await tenants?.get(tenantId))?.settings.fixtureSeams).toEqual({ limit: 5 });
    await pool.query(`update app.tenants set settings = $2 where id = $1`, [
      tenantId,
      { fixtureSeams: { limit: 7 } },
    ]);
    // Settings are cached per process (F4): a change made outside the service invalidates it.
    server.app?.get(TenantConfigService).invalidate(tenantId);
    expect((await tenants?.get(tenantId))?.settings.fixtureSeams).toEqual({ limit: 7 });
  });

  it('a section needs a default for everything, its own key, and one definition', () => {
    const define = defineSettingsSection as (key: string, schema: z.ZodType) => unknown;
    expect(() => define('fixtureStrict', z.object({ n: z.number() }))).toThrow(
      'needs a default for every field',
    );
    expect(() => define('timeZone', z.string().default('UTC'))).toThrow('a base setting');
    expect(() => define('fixtureSeams', z.object({}).default({}))).toThrow('registered twice');
  });
});

describe('event envelopes', () => {
  const event = {
    id: 'evt-1',
    name: 'task.updated',
    tenantId: 't1',
    resourceType: 'task',
    resourceId: 'task-1',
    row: { id: 'task-1', done: true },
    before: { id: 'task-1', done: false },
    actor: { kind: 'agent', id: 'assistant' },
    subject: 'user:ana',
    channel: 'whatsapp',
    occurredAt: new Date().toISOString(),
    availableAt: new Date(Date.now() + 30_000).toISOString(),
  };

  it('parse an event as stored, and refuse one without a business', () => {
    expect(DomainEventEnvelope.parse(event)).toEqual(event);
    const { tenantId: _tenantId, ...orphan } = event;
    expect(DomainEventEnvelope.safeParse(orphan).success).toBe(false);
  });
});
