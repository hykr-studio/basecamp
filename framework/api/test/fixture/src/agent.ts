import {
  type AgentModule,
  call,
  defineScript,
  items,
  sameTitle,
  say,
  sayIn,
  verbs,
  written,
} from '@hykr/agents/script';
import { pick } from '@hykr/i18n';

const ADD = verbs('add', 'जोड़ो', 'జోడించు');
const DELETE = verbs('delete', 'हटाओ', 'తొలగించు');
const quoted = (title: string) => `"${title}"`;

/** add <title> → create-task; delete <title> → list-tasks → delete-task (parked for approval). */
const scripts = [
  defineScript({
    name: 'add',
    match: (text) => new RegExp(`^(?:${ADD})\\s+(.+)$`, 'iu').exec(text.trim())?.[1],
    step: (title, turn) => {
      const r = turn.result('create-task');
      if (!r) return [call('create-task', { title })];
      const added = (t: { title: string }) =>
        pick(
          {
            en: `Added ${quoted(t.title)}.`,
            hi: `${quoted(t.title)} जोड़ दिया।`,
            te: `${quoted(t.title)} జోడించాను.`,
          },
          turn.lang,
        );
      return [say(written(r, added, turn))];
    },
  }),
  defineScript({
    name: 'delete',
    match: (text) => new RegExp(`^(?:${DELETE})\\s+(.+)$`, 'iu').exec(text.trim())?.[1],
    step: (title, turn) => {
      const r = turn.result('delete-task');
      if (r)
        return [
          say(
            written(
              r,
              () => pick({ en: 'Deleted.', hi: 'हटा दिया।', te: 'తొలగించాను.' }, turn.lang),
              turn,
            ),
          ),
        ];
      const list = turn.result('list-tasks');
      if (!list) return [call('list-tasks', {})];
      const target = items(list).find((t) => sameTitle(t.title, title));
      if (!target)
        return [sayIn(turn, { en: 'No such task.', hi: 'ऐसा कोई काम नहीं।', te: 'అలాంటి పని లేదు.' })];
      return [call('delete-task', { id: target.id })];
    },
  }),
];

/** What the tasks module teaches the assistant; the application keeps the persona (index.ts). */
export const tasksAgent: AgentModule = {
  help: 'I can add or delete tasks.',
  scripts,
  // `basecamp eval --module tasks`: one conversation, a fresh user.
  evalCases: [
    {
      why: 'adds a task',
      input: 'add Buy milk',
      expect: { must: ['create-task'], replyIncludes: 'milk' },
    },
    {
      why: "an agent's delete is parked for approval, and says so",
      input: 'delete Buy milk',
      expect: { must: ['list-tasks', 'delete-task'], replyIncludes: 'approv' },
    },
  ],
};
