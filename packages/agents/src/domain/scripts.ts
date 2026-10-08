import {
  call,
  dayWords,
  defineScript,
  items,
  plural,
  sameTitle,
  say,
  sayIn,
  startOfDay,
  verbs,
  written,
} from '../fake/engine.js';

/**
 * The scripted model's knowledge of THIS domain (for tests, CI and demos without a key):
 *   add <title>                     create-todo
 *   list                            list-todos
 *   done <title>                    list-todos → update-todo { done: true }
 *   delete <title>                  list-todos → delete-todo (parked for approval)
 *   today                           list-meetings + list-todos for today → summary
 *   close <meeting>\n<summary>\n- item …   list-meetings → close-meeting (parked for approval)
 *   move <meeting> to <YYYY-MM-DD>  list-meetings → reschedule-meeting
 *   what's due this week            list-todos due within 7 days → one line (the view shows them)
 *   open <meeting>                  list-meetings → canvas-open; without a canvas, get-meeting
 *   plan my week                    canvas-compose (week, to-dos due, meetings to prepare);
 *                                   without a canvas, the three lists, then one line
 *   only overdue                    canvas-patch on the page's to-do block; without one, list-todos
 *
 * Add, list, done and delete also take Hindi and Telugu verbs, before or after the title
 * ("జోడించు Call the plumber", "Order tiles हटाओ"), and answer in the turn's language.
 */
const dueText = (ymd: unknown) => (ymd ? ` (due ${dayWords(String(ymd))})` : '');

const first = (text: string) => text.split('\n')[0]?.trim() ?? '';

/**
 * Each command's verbs, in every language the product speaks: those that may lead the line
 * ("add Tiles", "जोड़ो Tiles"), and those that may end it, as Hindi and Telugu put a verb
 * ("Tiles जोड़ो"). The bare "पूरा" / "పూర్తి" also mean "whole", so they count only at the end.
 */
const VERBS = {
  add: {
    first: verbs('add', 'जोड़ो', 'जोड़ें', 'జోడించు', 'జోడించండి'),
    last: verbs('जोड़ो', 'जोड़ें', 'జోడించు', 'జోడించండి'),
  },
  done: {
    first: verbs('done', 'पूरा करो', 'పూర్తి చేయి'),
    last: verbs('पूरा करो', 'पूरा', 'పూర్తి చేయి', 'పూర్తి'),
  },
  delete: {
    first: verbs('delete', 'हटाओ', 'हटाएं', 'తొలగించు', 'తొలగించండి'),
    last: verbs('हटाओ', 'हटाएं', 'తొలగించు', 'తొలగించండి'),
  },
  list: verbs('list', 'सूची', 'सूची दिखाओ', 'జాబితా', 'జాబితా చూపించు'),
};
type Verb = { first: string; last: string };

/** "<title> <verb>": the title, when the line ends with one of the verbs. */
const endsWith = (verb: Verb, text: string) =>
  new RegExp(`^(.+?)\\s+(?:${verb.last})$`, 'iu').exec(first(text))?.[1];
/** "<verb> <title>". */
const startsWith = (verb: Verb, text: string) =>
  new RegExp(`^(?:${verb.first})\\s+(.+)$`, 'iu').exec(first(text))?.[1];
/** A verb at the end decides first (that is where Hindi and Telugu put it), then one at the start. */
const command = (verb: Verb, text: string) => endsWith(verb, text) ?? startsWith(verb, text);
const quoted = (title: string) => `"${title}"`;

export const domainScripts = [
  defineScript({
    name: 'add',
    match: (text) => command(VERBS.add, text),
    step: (title, turn) => {
      const r = turn.result('create-todo');
      if (!r) return [call('create-todo', { title })];
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
    name: 'list',
    match: (text) => (new RegExp(`^(?:${VERBS.list})$`, 'iu').test(first(text)) ? true : undefined),
    step: (_, turn) => {
      const r = turn.result('list-todos');
      if (!r) return [call('list-todos', {})];
      // Spoken: the gist the server worded for this language; the checklist is on screen.
      if (turn.spoken && r.speech) return [say(r.speech)];
      const todos = items(r);
      if (todos.length === 0)
        return [
          sayIn(turn, {
            en: 'You have no to-dos.',
            hi: 'आपके कोई काम नहीं हैं।',
            te: 'మీకు పనులు ఏవీ లేవు.',
          }),
        ];
      return [say(todos.map((t) => `[${t.done ? 'x' : ' '}] ${t.title}`).join('\n'))];
    },
  }),
  defineScript({
    name: 'done-or-delete',
    match: (text) => {
      // The verb at the end of the line decides ("पूरा घर साफ़ करो हटाओ" is a delete).
      const lastDone = endsWith(VERBS.done, text);
      const lastDelete = endsWith(VERBS.delete, text);
      if (lastDelete) return { verb: 'delete' as const, title: lastDelete };
      if (lastDone) return { verb: 'done' as const, title: lastDone };
      const done = startsWith(VERBS.done, text);
      if (done) return { verb: 'done' as const, title: done };
      const del = startsWith(VERBS.delete, text);
      return del ? { verb: 'delete' as const, title: del } : undefined;
    },
    step: ({ verb, title }, turn) => {
      const tool = verb === 'done' ? 'update-todo' : 'delete-todo';
      const r = turn.result(tool);
      if (r) {
        const said = (t: { title: string }) =>
          verb === 'done'
            ? {
                en: `Updated ${quoted(t.title)}.`,
                hi: `${quoted(t.title)} पूरा हो गया।`,
                te: `${quoted(t.title)} పూర్తి చేశాను.`,
              }[turn.lang]
            : { en: 'Deleted.', hi: 'हटा दिया।', te: 'తొలగించాను.' }[turn.lang];
        return [say(written(r, said, turn))];
      }
      const list = turn.result('list-todos');
      if (!list) return [call('list-todos', {})];
      const target = items(list).find((t) => sameTitle(t.title, title));
      if (!target)
        return [
          sayIn(turn, {
            en: `I couldn't find a to-do called ${quoted(title)}.`,
            hi: `${quoted(title)} नाम का कोई काम नहीं मिला।`,
            te: `${quoted(title)} అనే పని దొరకలేదు.`,
          }),
        ];
      return [call(tool, verb === 'done' ? { id: target.id, done: true } : { id: target.id })];
    },
  }),
  defineScript({
    name: 'due-week',
    match: (text) => (/^what('?s| is) due this week\??$/i.test(first(text)) ? true : undefined),
    step: (_, turn) => {
      const end = new Date(Date.now() + 7 * 86_400_000).toLocaleDateString('sv', {
        timeZone: turn.zone,
      });
      const r = turn.result('list-todos');
      if (!r) return [call('list-todos', { done: false, dueOn: { lte: end }, sort: 'dueOn' })];
      const n = items(r).length;
      // The result is shown as a checklist (or rendered to text): one line, not the list.
      return [
        say(n ? `${plural(n, 'to-do')} due by ${dayWords(end)}.` : 'Nothing is due this week.'),
      ];
    },
  }),
  defineScript({
    name: 'today',
    match: (text) => (/^today$/i.test(first(text)) ? true : undefined),
    step: (_, turn) => {
      const meetings = turn.result('list-meetings');
      if (!meetings) {
        const start = startOfDay(turn.today, turn.zone);
        return [
          call('list-meetings', {
            startsAt: {
              gte: start.toISOString(),
              lte: new Date(start.getTime() + 86_399_999).toISOString(),
            },
            sort: 'startsAt',
          }),
        ];
      }
      const todos = turn.result('list-todos');
      if (!todos)
        return [call('list-todos', { done: false, dueOn: { lte: turn.today }, sort: 'dueOn' })];
      const at = (iso: unknown) =>
        new Date(String(iso)).toLocaleTimeString('en-GB', {
          timeZone: turn.zone,
          hour: '2-digit',
          minute: '2-digit',
        });
      const m = items(meetings).map((x) => `- ${x.title} at ${at(x.startsAt)}`);
      const t = items(todos).map((x) => `- ${x.title}${dueText(x.dueOn)}`);
      return [
        say(
          [
            `Today: ${plural(m.length, 'meeting')}, ${plural(t.length, 'to-do')} due or overdue.`,
            ...m,
            ...(t.length ? ['To-dos:', ...t] : []),
          ].join('\n'),
        ),
      ];
    },
  }),
  defineScript({
    name: 'close',
    match: (text) => {
      const [line = '', ...rest] = text.split('\n');
      const m = /^close\s+(.+)$/i.exec(line.trim());
      if (!m) return undefined;
      const lines = rest.map((l) => l.trim()).filter(Boolean);
      return {
        title: m[1],
        summary: lines.find((l) => !l.startsWith('- ')) ?? `Closed ${m[1]}.`,
        items: lines.filter((l) => l.startsWith('- ')).map((l) => l.slice(2).trim()),
      };
    },
    step: (intent, turn) => {
      const r = turn.result('close-meeting');
      if (r) return [say(written(r, () => `Closed ${intent.title}.`))];
      const list = turn.result('list-meetings');
      if (!list) return [call('list-meetings', { q: intent.title })];
      const meeting = items(list).find((x) => sameTitle(x.title, intent.title)) ?? items(list)[0];
      if (!meeting) return [say(`I couldn't find a meeting called "${intent.title}".`)];
      return [
        call('close-meeting', {
          meetingId: meeting.id,
          summary: intent.summary,
          decisions: [],
          actionItems: intent.items.map((title) => ({ title })),
        }),
      ];
    },
  }),
  defineScript({
    name: 'move',
    match: (text) => {
      const m = /^move (.+) to (\d{4}-\d{2}-\d{2})$/i.exec(first(text));
      return m ? { title: m[1], date: m[2] } : undefined;
    },
    step: ({ title, date }, turn) => {
      const r = turn.result('reschedule-meeting');
      if (r) return [say(written(r, () => `Moved ${title} to ${date}.`))];
      const list = turn.result('list-meetings');
      if (!list) return [call('list-meetings', { q: title })];
      const meeting = items(list).find((x) => sameTitle(x.title, title)) ?? items(list)[0];
      if (!meeting) return [say(`I couldn't find a meeting called "${title}".`)];
      // Keep the time of day and the length; change the date.
      const start = new Date(String(meeting.startsAt));
      const length = new Date(String(meeting.endsAt)).getTime() - start.getTime();
      const startsAt = new Date(`${date}T${start.toISOString().slice(11)}`);
      return [
        call('reschedule-meeting', {
          meetingId: meeting.id,
          startsAt: startsAt.toISOString(),
          endsAt: new Date(startsAt.getTime() + length).toISOString(),
        }),
      ];
    },
  }),
  defineScript({
    name: 'open-meeting',
    match: (text) => {
      const m = /^(?:open|show) (?:the )?(.+?)\.?$/i.exec(first(text));
      return m && !/^(today|list)$/i.test(m[1]) ? m[1] : undefined;
    },
    step: (title, turn) => {
      const meetings = turn.result('list-meetings');
      if (!meetings) return [call('list-meetings', { q: title })];
      const meeting = items(meetings).find((m) => sameTitle(m.title, title)) ?? items(meetings)[0];
      if (!meeting) return [say(`I couldn't find "${title}".`)];
      if (turn.surfaces.includes('canvas')) {
        if (!turn.result('canvas-open'))
          return [call('canvas-open', { screen: 'meeting.detail', params: { id: meeting.id } })];
        return [say(`Opened ${meeting.title}.`)];
      }
      if (!turn.result('get-meeting')) return [call('get-meeting', { id: meeting.id })];
      return [say(`Here is ${meeting.title}.`)];
    },
  }),
  defineScript({
    name: 'plan-week',
    match: (text) => (/^plan my week\.?$/i.test(first(text)) ? true : undefined),
    step: (_, turn) => {
      const end = new Date(Date.now() + 6 * 86_400_000).toLocaleDateString('sv', {
        timeZone: turn.zone,
      });
      const week = {
        gte: startOfDay(turn.today, turn.zone).toISOString(),
        lte: new Date(startOfDay(end, turn.zone).getTime() + 86_399_999).toISOString(),
      };
      const queries = {
        meetings: { startsAt: week, sort: 'startsAt' },
        todos: { done: false, dueOn: { lte: end }, sort: 'dueOn' },
        prep: {
          status: 'scheduled',
          startsAt: { gte: new Date().toISOString(), lte: week.lte },
          sort: 'startsAt',
        },
      };
      if (turn.surfaces.includes('canvas')) {
        if (!turn.result('canvas-compose'))
          return [
            call('canvas-compose', {
              title: 'My week',
              layout: 'two-column',
              blocks: [
                {
                  id: 'week',
                  view: 'calendar.week',
                  span: 'full',
                  props: { title: 'This week', start: turn.today },
                  query: queries.meetings,
                },
                {
                  id: 'todos',
                  view: 'todo.list',
                  props: { title: 'Due this week' },
                  query: queries.todos,
                },
                {
                  id: 'prep',
                  view: 'meeting.list',
                  props: { title: 'Meetings to prepare' },
                  query: queries.prep,
                },
              ],
            }),
          ];
        return [say('Here is your week: meetings, what is due, and what to prepare.')];
      }
      // No canvas: the same three lists, each rendered to words by the server.
      const listed = turn.steps.filter((s) => s.toolName.startsWith('list-'));
      if (listed.length === 0) return [call('list-meetings', queries.meetings)];
      if (listed.length === 1) return [call('list-todos', queries.todos)];
      if (listed.length === 2) return [call('list-meetings', queries.prep)];
      const [m, t] = listed;
      return [
        say(
          `Your week: ${plural(items(m.outcome).length, 'meeting')}, ${plural(items(t.outcome).length, 'to-do')} due.`,
        ),
      ];
    },
  }),
  defineScript({
    name: 'overdue',
    match: (text) => (/^only (the )?overdue( ones)?\.?$/i.test(first(text)) ? true : undefined),
    step: (_, turn) => {
      const query = { done: false, dueOn: { lt: turn.today }, sort: 'dueOn' };
      const block = turn.canvas?.blocks.find((b) => b.view === 'todo.list');
      if (block && turn.surfaces.includes('canvas')) {
        if (!turn.result('canvas-patch'))
          return [call('canvas-patch', { blockId: block.id, query, props: { title: 'Overdue' } })];
        return [say('Showing only the overdue ones.')];
      }
      const r = turn.result('list-todos');
      if (!r) return [call('list-todos', query)];
      const n = items(r).length;
      return [say(n ? `${plural(n, 'to-do')} overdue.` : 'Nothing is overdue.')];
    },
  }),
];
