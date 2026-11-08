// The module system's boot checks (F1), without booting: every way two modules (or a module and
// the framework) can collide fails defineServer with one ModulesError that lists every problem,
// instead of the later one silently replacing the earlier. Also the module id stamp, the agent
// merge and the route reservation registry.
import { mergeAgentModules, scriptConflicts, suitesFor } from '@hykr/agents';
import { call, defineScript, say } from '@hykr/agents/script';
import {
  type CommandSpec,
  commandSpec,
  createCatalog,
  type EntitySpec,
  entitySpec,
  ModulesError,
  moduleSpec,
  reservedRoutes,
  reserveRoutes,
} from '@hykr/contracts';
import { app, id } from '@hykr/db';
import { defineNotification, defineTemplate } from '@hykr/notifications';
import { createUiRegistry, defineScreen, defineView, type ViewDef } from '@hykr/ui-registry';
import { text } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineModule, defineServer, type ModuleDef } from '../../dist/index.js';
import { fixture } from '../fixture/dist/index.js';
import { tasks, visits } from '../fixture/dist/modules.js';

const Row = z.object({ id: z.string(), title: z.string() });

/** A fresh entity spec (specs are stamped with their module once, so tests never share one). */
const entity = (name: string, extra: Partial<EntitySpec> = {}): EntitySpec =>
  entitySpec({
    name,
    label: name,
    description: `${name}s.`,
    schemas: { read: Row, create: Row.omit({ id: true }), update: Row.partial() },
    list: {
      filterable: {},
      sortable: [],
      defaultSort: [],
      search: [],
      pageSize: { default: 10, max: 10 },
    },
    ...extra,
  });

const command = (name: string, path: string, extra: Partial<CommandSpec> = {}): CommandSpec =>
  commandSpec({
    name,
    description: name,
    input: z.object({}),
    output: z.object({}),
    http: { method: 'POST', path },
    expose: 'all',
    ...extra,
  });

/** A module of one entity named after it ('a' → entity 'a', plural 'as'). */
const mod = (name: string, extra: Partial<ModuleDef> = {}): ModuleDef =>
  defineModule({
    name,
    entities: { [`${name}s`]: entity(name) },
    commands: [],
    ...extra,
  });

// The fixture's languages: the modules below have words in Hindi and Telugu.
const server = (...modules: ModuleDef[]) =>
  defineServer({
    name: 'Test',
    persona: 'You test.',
    languages: fixture.definition.languages,
    modules,
  });

/** The problems defineServer reports for these modules. */
function problems(run: () => unknown): readonly string[] {
  try {
    run();
  } catch (error) {
    if (error instanceof ModulesError) return error.problems;
    throw error;
  }
  throw new Error('expected a ModulesError');
}

describe('a module', () => {
  it('stamps each spec with its id; the catalog answers for names, plurals and tools', () => {
    const spec = entity('stamped');
    const cmd = command('stamped.ping', '/api/stampeds/ping', { tool: 'ping-stamped' });
    moduleSpec({ name: 'stamps', entities: { stampeds: spec }, commands: [cmd] });
    expect(spec.module).toBe('stamps');
    expect(cmd.module).toBe('stamps');
    const catalog = createCatalog(
      moduleSpec({ name: 'stamps', entities: { stampeds: spec }, commands: [cmd] }),
    );
    expect(catalog.modules).toEqual([
      { name: 'stamps', dependsOn: [], entities: ['stamped'], commands: ['stamped.ping'] },
    ]);
    expect(catalog.moduleOf('stamped')).toBe('stamps');
    expect(catalog.moduleOf('stampeds')).toBe('stamps');
    expect(catalog.moduleOf('stamped.ping')).toBe('stamps');
    expect(catalog.moduleOf('page')).toBe('platform');
    expect(catalog.toolModule('ping-stamped')).toBe('stamps');
    expect(catalog.toolModule('list-stampeds')).toBe('stamps');
    expect(catalog.toolModule('send-template')).toBe('platform');
    expect(catalog.toolModule('canvas-open')).toBe('platform');
    expect(catalog.moduleOf('nothing')).toBeUndefined();
  });

  it('cannot claim a spec another module declares, or have a bad name', () => {
    const spec = entity('claimed');
    moduleSpec({ name: 'first', entities: { claimeds: spec }, commands: [] });
    expect(() =>
      moduleSpec({ name: 'second', entities: { claimeds: spec }, commands: [] }),
    ).toThrow('claimed belongs to the module first; second cannot declare it too');
    expect(() => moduleSpec({ name: 'Orders', entities: {}, commands: [] })).toThrow(/lower case/);
    expect(() => moduleSpec({ name: 'platform', entities: {}, commands: [] })).toThrow(/framework/);
    expect(() =>
      moduleSpec({ name: 'keys', entities: { wrong: entity('keyed') }, commands: [] }),
    ).toThrow(/keyed by its plural \(keyeds\)/);
  });

  it('the fixture is two modules, merged and checked when it was defined', () => {
    expect(fixture.catalog.modules.map((m) => m.name)).toEqual(['tasks', 'visits']);
    expect(fixture.catalog.moduleOf('visit.reschedule')).toBe('visits');
    expect(fixture.registry.moduleOf('task.list')).toBe('tasks');
    expect(fixture.registry.moduleOf('approval.card')).toBe('platform');
    expect(fixture.definition.modules).toEqual([tasks, visits]);
  });
});

describe('defineServer refuses modules that collide', () => {
  it('on entity names and plurals', () => {
    const a = mod('dup1');
    const b = defineModule({
      name: 'dup2',
      entities: { dup1s: entity('dup1', { plural: 'dup1s' }) },
      commands: [],
    });
    expect(problems(() => server(a, b))).toEqual(
      expect.arrayContaining([
        'The entity dup1 is declared by both dup1 and dup2',
        'The plural dup1s is declared by both dup1 and dup2',
      ]),
    );
  });

  it("on the framework's routes and the platform's entity", () => {
    const approvals = defineModule({
      name: 'appr',
      entities: { approvals: entity('approval') },
      commands: [],
    });
    expect(problems(() => server(approvals))).toContain(
      'appr: the plural approvals is a framework route (/api/approvals)',
    );
    const pages = defineModule({ name: 'pg', entities: { pages: entity('page') }, commands: [] });
    expect(problems(() => server(pages))).toEqual(
      expect.arrayContaining([
        'The entity page is declared by both pg and platform',
        'The plural pages is declared by both pg and platform',
      ]),
    );
    const cmd = mod('hist', { commands: [command('hist.peek', '/api/history/peek')] });
    expect(problems(() => server(cmd))).toContain(
      'hist: the command hist.peek uses /api/history, a framework route',
    );
  });

  it('on a route a framework feature reserved', () => {
    expect(reservedRoutes().has('fixturereserved')).toBe(false);
    reserveRoutes('fixturereserved');
    expect(reservedRoutes().has('fixturereserved')).toBe(true);
    const m = defineModule({
      name: 'res',
      entities: { fixturereserved: entity('reserved', { plural: 'fixturereserved' }) },
      commands: [],
    });
    expect(problems(() => server(m))).toContain(
      'res: the plural fixturereserved is a framework route (/api/fixturereserved)',
    );
    expect(() => reserveRoutes('Not/A segment')).toThrow(/Bad route segment/);
  });

  it('on command names, approval op names and tool ids', () => {
    const a = mod('opa', { commands: [command('opa.go', '/api/opas/go', { tool: 'go' })] });
    const b = mod('opb', {
      commands: [
        command('opa.go', '/api/opbs/go'),
        command('opa.create', '/api/opbs/make'),
        command('opb.list', '/api/opbs/list', { tool: 'list-opas' }),
      ],
    });
    expect(problems(() => server(a, b))).toEqual(
      expect.arrayContaining([
        'The command opa.go is declared by both opa and opb',
        'opb: the command opa.create has the name of an entity action of opa (approvals replay by name)',
        'The tool list-opas (opb opb.list) is also a tool of opa',
      ]),
    );
  });

  it('on method and path, a param matching any segment', () => {
    const a = mod('rta');
    const b = mod('rtb', {
      commands: [
        command('rtb.make', '/api/rtas'),
        command('rtb.edit', '/api/rtas/:rtaId', {
          http: { method: 'PATCH', path: '/api/rtas/:x' },
        }),
        command('rtb.fine', '/api/rtas/:rtaId/fine'),
      ],
    });
    expect(problems(() => server(a, b))).toEqual([
      'POST /api/rtas (rta rta) and /api/rtas (rtb rtb.make) are the same route',
      'PATCH /api/rtas/: (rta rta) and /api/rtas/: (rtb rtb.edit) are the same route',
    ]);
  });

  it('on touches, dependsOn and the order of modules', () => {
    const a = mod('dpa', { dependsOn: ['dpb'] });
    const b = mod('dpb', {
      dependsOn: ['nowhere'],
      commands: [command('dpb.go', '/api/dpbs/go', { touches: ['dpa', 'ghost'] })],
    });
    expect(problems(() => server(a, b))).toEqual([
      'dpa depends on dpb: list dpb before dpa',
      'dpb depends on nowhere, which is not one of the modules',
      'dpb: the command dpb.go touches ghost, which is no entity',
    ]);
    expect(problems(() => server(mod('twice'), mod('twice')))).toContain(
      'The module twice is listed twice',
    );
  });

  it('on view and screen names', () => {
    const view = (name: string) =>
      defineView({
        name,
        description: name,
        surfaces: ['inline'],
        props: z.object({ items: z.array(Row) }),
        labels: {},
        text: () => '',
        speak: () => '',
      }) as unknown as ViewDef;
    const screen = defineScreen({
      name: 'same.screen',
      title: 'x',
      description: 'x',
      params: z.object({}),
    });
    const a = mod('vwa', { views: [view('same.view')], screens: [screen] });
    const b = mod('vwb', { views: [view('same.view'), view('approval.card')], screens: [screen] });
    expect(problems(() => server(a, b))).toEqual(
      expect.arrayContaining([
        'The view same.view is declared by both vwa and vwb',
        'The view approval.card is declared by both platform and vwb',
        'The screen same.screen is declared by both vwa and vwb',
      ]),
    );
    expect(() => createUiRegistry({ views: [view('x.v'), view('x.v')] })).toThrow(ModulesError);
  });

  it('on templates and notification keys, and a notification sending a template it lacks', () => {
    const body = { en: 'Hi {{name}}', hi: 'Hi {{name}}', te: 'Hi {{name}}' };
    const template = (name: string) =>
      defineTemplate({
        name,
        category: 'utility',
        params: z.object({ name: z.string() }),
        body,
        example: { name: 'Asha' },
      });
    const notice = (key: string, t = template('nt_kept_v1')) =>
      defineNotification({
        key,
        topic: 'service',
        to: () => [],
        channels: ['whatsapp'],
        whatsapp: { template: t, params: () => ({ name: 'x' }) },
        dedupe: (r) => r.id,
      });
    const a = mod('nta', {
      templates: [template('nt_same_v1')],
      notifications: [notice('nt.same')],
    });
    const b = mod('ntb', {
      templates: [template('nt_same_v1')],
      notifications: [notice('nt.same')],
    });
    expect(problems(() => server(a, b))).toEqual(
      expect.arrayContaining([
        'The template nt_same_v1 is defined twice',
        'The notification nt.same is defined twice',
        'The notification nt.same sends nt_kept_v1, which is not a template here',
      ]),
    );
  });

  it('on what one part names in another: views, actions, screens, sources, events', () => {
    const listed = entity('crs', { views: { list: 'crs.missing' } });
    const orphan = entity('orphan');
    const view = defineView({
      name: 'crs.list',
      description: 'x',
      surfaces: ['inline'],
      props: z.object({ items: z.array(Row) }),
      source: { entity: orphan, into: 'items' },
      actions: {
        run: { command: 'crs.explode', args: () => ({}) },
        tick: { command: 'crs.update', args: () => ({}) },
        open: { screen: 'crs.nowhere', params: () => ({}) },
      },
      labels: {},
      text: () => '',
      speak: () => '',
    }) as unknown as ViewDef;
    const t = defineTemplate({
      name: 'crs_v1',
      category: 'utility',
      params: z.object({}),
      body: { en: 'x', hi: 'x', te: 'x' },
      example: {},
    });
    const n = defineNotification({
      key: 'crs.n',
      topic: 'service',
      schedule: { on: ['crs.created', 'crss.updated', 'crs.closed'], at: () => null },
      to: () => [],
      channels: ['whatsapp'],
      whatsapp: { template: t, params: () => ({}) },
      dedupe: (r) => r.id,
    });
    const m = defineModule({
      name: 'crs',
      entities: { crss: listed },
      commands: [command('crs.go', '/api/crss/go', { view: { name: 'crs.gone', id: () => '' } })],
      views: [view],
      templates: [t],
      notifications: [n],
    });
    expect(problems(() => server(m))).toEqual([
      'crs: the crs list is shown as crs.missing, no view',
      'crs: the result of crs.go is shown as crs.gone, no view',
      'crs: the view crs.list lists orphan, which is no entity',
      "crs: crs.list's action run runs crs.explode, no command",
      "crs: crs.list's action open opens crs.nowhere, no screen",
      "crs: the notification crs.n follows crss.updated, no entity's event",
    ]);
  });

  it('on tables: named after the module, unique, not the framework', () => {
    const own = app.table('tba', { id: id() });
    const other = app.table('tbother', { id: id() });
    const tenants = app.table('tenants', { id: text('id') });
    const a = mod('tba', { tables: { own, other } });
    const b = mod('tbb', { tables: { own, tenants } });
    expect(problems(() => server(a, b))).toEqual([
      'tba: the table app.tbother must be named tba or tba_…',
      'tbb: the table app.tba must be named tbb or tbb_…',
      'The table app.tba is declared by both tba and tbb',
      'tbb: the table app.tenants must be named tbb or tbb_…',
      "tbb: the table app.tenants is one of the framework's",
    ]);
    // An application-wide prefix (two applications in one database).
    const prefixed = mod('tbp', { tables: { t: app.table('acme_tbp_lines', { id: id() }) } });
    expect(() =>
      defineServer({ name: 'T', persona: 'p', modules: [prefixed], tablePrefix: 'acme_' }),
    ).not.toThrow();
  });

  it("on a script that takes another module's eval turn", () => {
    const greedy = defineScript({
      name: 'greedy',
      match: (text) => (/^zap /.test(text) ? true : undefined),
      step: () => [say('zapped')],
    });
    const a = mod('sca', { agent: { scripts: [greedy] } });
    const b = mod('scb', {
      agent: { evalCases: [{ why: 'zap', input: 'zap it', expect: { must: ['create-scb'] } }] },
    });
    expect(problems(() => server(a, b))).toEqual([
      'scb\'s eval turn "zap it" is taken by sca\'s script "greedy"',
    ]);
  });

  it('reports every problem at once', () => {
    let error: unknown;
    try {
      server(mod('all1'), mod('all1'), mod('all2', { dependsOn: ['all3'] }));
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ModulesError);
    expect((error as Error).message).toMatch(/^Modules do not fit together:\n- /);
    expect((error as ModulesError).problems.length).toBeGreaterThanOrEqual(3);
  });
});

describe("the modules' agent parts", () => {
  const s = (name: string) =>
    defineScript({ name, match: () => undefined, step: () => [call('noop', {})] });

  it('merge in module order, with one eval suite per module', () => {
    const domain = mergeAgentModules({ persona: 'You help.' }, [
      { name: 'one', agent: { rules: ['r1'], help: 'One.', scripts: [s('s1')] } },
      { name: 'two' },
      {
        name: 'three',
        agent: {
          rules: ['r3'],
          help: 'Three.',
          scripts: [s('s3')],
          evalCases: [{ why: 'w', input: 'i', expect: { must: [] } }],
        },
      },
    ]);
    expect(domain.persona).toBe('You help.');
    expect(domain.rules).toEqual(['r1', 'r3']);
    expect(domain.scripts.map((x) => x.name)).toEqual(['s1', 's3']);
    expect(domain.help).toBe('One. Three.');
    expect(domain.suites.map((x) => [x.module, x.evalCases.length])).toEqual([
      ['one', 0],
      ['two', 0],
      ['three', 1],
    ]);
    expect(mergeAgentModules({ persona: 'p', help: 'Mine.' }, []).help).toBe('Mine.');
    expect(suitesFor(domain, 'three').map((x) => x.module)).toEqual(['three']);
    expect(() => suitesFor(domain, 'four')).toThrow(
      'No module called four (modules: one, two, three)',
    );
  });

  it("the fixture's own scripts take only their own turns", () => {
    expect(scriptConflicts(fixture.definition.modules)).toEqual([]);
    expect(fixture.agentDomain.help).toBe('I can add or delete tasks.');
    expect(fixture.agentDomain.suites.map((x) => x.module)).toEqual(['tasks', 'visits']);
  });
});
