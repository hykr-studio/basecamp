import {
  type AgentDomain,
  call,
  defineScript,
  items,
  sameTitle,
  say,
  sayIn,
  verbs,
  written,
} from '@hykr/agents/script';

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
        ({
          en: `Added ${quoted(t.title)}.`,
          hi: `${quoted(t.title)} जोड़ दिया।`,
          te: `${quoted(t.title)} జోడించాను.`,
        })[turn.lang];
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
              () => ({ en: 'Deleted.', hi: 'हटा दिया।', te: 'తొలగించాను.' })[turn.lang],
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

export const fixtureAgent: AgentDomain = {
  persona: 'You are a test assistant. You help the user keep tasks and visits.',
  rules: [],
  help: 'I can add or delete tasks.',
  scripts,
  evalCases: [],
};
