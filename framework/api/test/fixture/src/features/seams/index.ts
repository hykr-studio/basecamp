// The framework's extension points as an application uses them: its own trait and settings
// section (declared by declaration merging, checked by tsc), a module's shape, and one
// contribution of every kind, from a module. Only the seams e2e test boots `seams`; the fixture
// contributes nothing, so the other tests run without these.
import { defineModule, defineServer } from '@hykr/api';
import {
  type Contributions,
  commandSpec,
  defineSettingsSection,
  entitySpec,
} from '@hykr/contracts';
import { z } from 'zod';
import { fixture } from '../../index.js';

declare module '@hykr/contracts' {
  interface EntityTraits {
    fixtureNoted?: { note: string };
  }
  interface CommandTraits {
    fixtureNoted?: { note: string };
  }
  interface TenantSettingsSections {
    fixtureSeams: { limit: number };
  }
}

/** A settings section: every field has a default, so a new business has it as is. */
export const SeamsSettings = defineSettingsSection(
  'fixtureSeams',
  z.object({ limit: z.number().int().min(0).default(5) }).default({ limit: 5 }),
);

/** Specs carrying the fixture's trait (not served: only the spec is under test). */
export const NotedSpec = entitySpec({
  name: 'noted',
  label: 'noted thing',
  description: 'A spec that carries a trait.',
  schemas: { read: z.object({ id: z.string() }), create: z.object({}), update: z.object({}) },
  list: {
    filterable: {},
    sortable: [],
    defaultSort: [],
    search: [],
    pageSize: { default: 10, max: 10 },
  },
  traits: { fixtureNoted: { note: 'kept' } },
});

export const NoteItSpec = commandSpec({
  name: 'noted.note',
  description: 'A command that carries a trait.',
  input: z.object({}),
  output: z.object({}),
  http: { method: 'POST', path: '/api/noted/note' },
  expose: 'all',
  traits: { fixtureNoted: { note: 'kept' } },
});

const NAME = 'fixture.seams';

/** One of each kind. None changes behaviour: the projector only drops a field tasks don't have. */
export const seamsContributions: Partial<Contributions> = {
  entityPlugins: [{ name: NAME, appliesTo: (spec) => spec.traits?.fixtureNoted !== undefined }],
  writeHooks: [{ name: NAME }],
  readProjectors: [
    {
      name: NAME,
      project: (type, value) => {
        if (type !== 'task') return value;
        const { secret: _secret, ...rest } = value;
        return rest;
      },
    },
  ],
  identityProviders: [{ name: NAME, identify: async () => null }],
  toolContributions: [{ name: NAME, tools: () => ({}) }],
  deliveryChannels: [
    { name: NAME, deliver: async () => ({ status: 'unavailable', reason: 'fixture' }) },
  ],
  turnHooks: [{ name: NAME }],
  inboundHooks: [{ name: NAME, onMessage: async () => null }],
  queues: [{ name: NAME }],
  schedules: [{ name: NAME, queue: NAME, every: 60_000 }],
  erasureContributors: [{ name: NAME, erase: async () => ({ count: 0 }) }],
  exportContributors: [{ name: NAME, export: async () => ({}) }],
  authPlugins: [{ name: NAME, trustedOrigins: [] }],
};

/** A module that adds no entities, only hooks: its contributions are installed with the app's. */
export const seamsModule = defineModule({
  name: 'seams',
  dependsOn: [],
  entities: {},
  commands: [],
  agent: { rules: ['Nothing to add.'] },
  contributes: seamsContributions,
});

/** The fixture, plus the module. */
export const seams = defineServer({
  ...fixture.definition,
  modules: [...fixture.definition.modules, seamsModule],
});
