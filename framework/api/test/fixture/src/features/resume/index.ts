// Durable runs (A7) as an application uses them: an assistant's plan whose middle step waits for
// approval and whose last step runs once it is approved, and a turn hook that can refuse a
// resumed run. Only the resume e2e test boots `resumeApp`; what the hook saw is kept in `seen`.

import { call, decided, defineScript, items, sameTitle, say, written } from '@hykr/agents/script';
import { defineModule, defineServer, type TurnHook, type TurnInfo } from '@hykr/api';
import { moduleSpec } from '@hykr/contracts';
import { fixture } from '../../index.js';

/** What the turn hook saw; `refuse` makes it refuse resumed runs. */
export const seen = { turns: [] as TurnInfo[], refuse: false };

/**
 *   tidy <title>   list-tasks → delete-task (waits for approval). Once approved, the run goes
 *                  on: create-task "Tidied <title>" (a write, audited under the same run), then
 *                  how many tasks are left. Rejected or expired: nothing changed.
 *   tidy both <a> and <b>   list-tasks → two delete-task calls in one step (each waits for its
 *                  own approval). The run goes on once both are decided: how each went.
 */
const scripts = [
  defineScript({
    name: 'tidy-both',
    match: (text) => {
      const m = /^tidy both (.+) and (.+)$/i.exec(text.trim());
      return m ? [m[1], m[2]] : undefined;
    },
    step: (titles, turn) => {
      const removed = turn.steps.filter((s) => s.toolName === 'delete-task');
      if (removed.length) {
        const how = removed.map((s) => decided(s.outcome) ?? 'waiting');
        return [say(`Both decided: ${how.join(' and ')}.`)];
      }
      const list = turn.result('list-tasks');
      if (!list) return [call('list-tasks', {})];
      const ids = titles.map((title) => items(list).find((t) => sameTitle(t.title, title))?.id);
      if (ids.some((id) => !id)) return [say('No such task.')];
      return ids.map((id) => call('delete-task', { id }));
    },
  }),
  defineScript({
    name: 'tidy',
    match: (text) => /^tidy (.+)$/i.exec(text.trim())?.[1],
    step: (title, turn) => {
      const removed = turn.result('delete-task');
      if (removed && decided(removed) === 'approved') {
        if (!turn.result('create-task')) return [call('create-task', { title: `Tidied ${title}` })];
        const lists = turn.steps.filter((s) => s.toolName === 'list-tasks');
        if (lists.length < 2) return [call('list-tasks', {})];
        const left = items(lists[1].outcome).filter((t) => !t.title.startsWith('Tidied'));
        return [say(`Tidied "${title}". ${left.length} left.`)];
      }
      if (removed) return [say(written(removed, () => 'Tidied.', turn))];
      const list = turn.result('list-tasks');
      if (!list) return [call('list-tasks', {})];
      const target = items(list).find((t) => sameTitle(t.title, title));
      if (!target) return [say('No such task.')];
      return [call('delete-task', { id: target.id })];
    },
  }),
];

/** Sees every turn; refuses a resumed run when the test says so. */
const ResumeGate: TurnHook = {
  name: 'fixture.resume.gate',
  before: async (turn) => {
    seen.turns.push(turn);
    if (turn.kind !== 'resume' || !seen.refuse) return null;
    return {
      refuse: {
        rule: 'fixture_paused',
        reason: 'Paused for the test',
        say: { en: 'Paused for the test.', hi: 'परीक्षण के लिए रुका है।', te: 'పరీక్ష కోసం ఆగింది.' },
      },
    };
  },
};

export const resumeModule = defineModule({
  ...moduleSpec({ name: 'resume', dependsOn: ['tasks'], entities: {}, commands: [] }),
  agent: { scripts },
});

/** The fixture, with the plan above and the gate. */
export const resumeApp = defineServer({
  ...fixture.definition,
  modules: [...fixture.definition.modules, resumeModule],
  contributes: { turnHooks: [ResumeGate] },
});
