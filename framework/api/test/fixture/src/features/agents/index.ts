// Agents a business makes (A6), as an application meets them: a `bots` module with scripts for
// its runs and one template, beside the members fixture's projects (whose cost only some
// capabilities read) and a role that makes agents and reaches every project without the cost.
// Only the agents e2e test boots `agentsApp`. Its tables are the framework's and the members set's.
import {
  call,
  decided,
  defineScript,
  items,
  plural,
  runData,
  say,
  written,
} from '@hykr/agents/script';
import { defineAgentTemplate, defineModule, defineServer } from '@hykr/api';
import { defineRole, moduleSpec } from '@hykr/contracts';
import { fixture } from '../../index.js';
import { membersContributions, projectsModule } from '../members/index.js';

const label = (en: string) => ({ en, hi: en, te: en });
const first = (text: string) => text.split('\n')[0]?.trim() ?? '';

type Data = {
  record?: { id?: string; title?: string };
  comment?: { on?: { id?: string } };
  note?: string;
};

/** The record a run is about: an event's or a condition's record, a comment's, or a run's note. */
const recordOf = (text: string): string | undefined => {
  const d = (runData(text) ?? {}) as Data;
  return d.record?.id ?? d.comment?.on?.id ?? d.note;
};

/**
 * What the fixture's agents do (the first line of a run's message is the agent's instructions):
 *   Count my open tasks.             list-tasks → "N open tasks: a, b"
 *   Report what started this run.    says the run's data back, as JSON
 *   Read the task in the data.       get-task on the record (or the note) → its title, or a refusal
 *   Add a follow-up task.            create-task "Follow up <title>" for the event's task
 *   Tidy the task in the data.       delete-task (waits for approval); once approved,
 *                                    create-task "Tidied <title>" → "Tidied <title>."
 */
const scripts = [
  defineScript({
    name: 'bots-count',
    match: (text) => (/^count my open tasks\.?$/i.test(first(text)) ? true : undefined),
    step: (_, turn) => {
      const r = turn.result('list-tasks');
      if (!r) return [call('list-tasks', { done: false })];
      if (!r.ok) return [say("I couldn't list the tasks.")];
      const titles = items(r).map((t) => t.title);
      return [say(`${plural(titles.length, 'open task')}: ${titles.join(', ') || 'none'}.`)];
    },
  }),
  defineScript({
    name: 'bots-report',
    match: (text) => (/^report what started this run\.?$/i.test(first(text)) ? text : undefined),
    step: (text) => [say(`Started by: ${JSON.stringify(runData(text) ?? null)}`)],
  }),
  defineScript({
    name: 'bots-read',
    match: (text) => (/^read the task in the data\.?$/i.test(first(text)) ? text : undefined),
    step: (text, turn) => {
      const id = recordOf(text);
      if (!id) return [say('No task in the data.')];
      const r = turn.result('get-task');
      if (!r) return [call('get-task', { id })];
      if (!r.ok) return [say(`Refused: ${(r as { status?: number }).status ?? 'no'}.`)];
      return [say(`The task is "${(r.result as { title: string }).title}".`)];
    },
  }),
  defineScript({
    name: 'bots-follow',
    match: (text) => (/^add a follow-up task\.?$/i.test(first(text)) ? text : undefined),
    step: (text, turn) => {
      const title = ((runData(text) ?? {}) as Data).record?.title ?? '';
      if (!title || title.startsWith('Follow up')) return [say('Nothing to follow up.')];
      const r = turn.result('create-task');
      if (!r) return [call('create-task', { title: `Follow up ${title}` })];
      return [say(written(r, () => `Added a follow-up for ${title}.`, turn))];
    },
  }),
  defineScript({
    name: 'bots-tidy',
    match: (text) => (/^tidy the task in the data\.?$/i.test(first(text)) ? text : undefined),
    step: (text, turn) => {
      const id = recordOf(text);
      const removed = turn.result('delete-task');
      if (removed && decided(removed) === 'approved') {
        if (!turn.result('create-task')) return [call('create-task', { title: `Tidied ${id}` })];
        return [say(`Tidied ${id}.`)];
      }
      if (removed) return [say(written(removed, () => 'Tidied.', turn))];
      if (!id) return [say('No task in the data.')];
      return [call('delete-task', { id })];
    },
  }),
];

/** A template the application offers: every Monday at nine, the open tasks. */
export const CountTasks = defineAgentTemplate({
  key: 'bots.count-tasks',
  name: label('Monday tasks'),
  description: label('Every Monday at 09:00: how many tasks are open.'),
  instructions: 'Count my open tasks.',
  triggers: [{ kind: 'recurring', cron: '0 9 * * 1' }],
  scope: { tools: ['list-tasks'] },
  budget: { period: 'week', runs: 5 },
});

/** One that names a tool this server does not have: listed, but not available. */
export const Unavailable = defineAgentTemplate({
  key: 'bots.unavailable',
  name: label('Not here'),
  description: label('Uses a tool this server does not have.'),
  instructions: 'Count my open tasks.',
  triggers: [],
  scope: { tools: ['list-nothing'] },
});

export const botsModule = defineModule({
  ...moduleSpec({ name: 'bots', dependsOn: ['tasks'], entities: {}, commands: [] }),
  agent: { scripts },
  contributes: { agentTemplates: [CountTasks, Unavailable] },
});

/** Makes agents and reaches every project (the members fixture's key), without reading its cost. */
export const Runner = defineRole({
  name: 'fixture_runner',
  label: label('Runner'),
  capabilities: ['agents.create', 'fixture.projects.all'],
});

/** The fixture with the projects module and the bots module. */
export const agentsApp = defineServer({
  ...fixture.definition,
  modules: [...fixture.definition.modules, projectsModule, botsModule],
  contributes: {
    ...membersContributions,
    roles: [...(membersContributions.roles ?? []), Runner],
  },
});
