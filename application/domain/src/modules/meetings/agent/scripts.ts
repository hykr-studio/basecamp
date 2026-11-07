import {
  call,
  dayWords,
  decided,
  defineScript,
  items,
  plural,
  runData,
  sameTitle,
  say,
  startOfDay,
  written,
} from '@hykr/agents/script';

/**
 * The scripted model's knowledge of the meetings module (for tests, CI and demos without a key):
 *   today                           list-meetings + list-todos for today → summary
 *   close <meeting>\n<summary>\n- item …   list-meetings → close-meeting (the run waits for approval;
 *                                   once approved it goes on: list-todos of the meeting → how many)
 *   close this one\n<notes>        on a meeting: close-meeting on it (likewise)
 *   move <meeting> to <YYYY-MM-DD>  list-meetings → reschedule-meeting
 *   open <meeting>                  list-meetings → canvas-open; without a canvas, get-meeting
 *   plan my week                    canvas-compose (week, to-dos due, meetings to prepare);
 *                                   without a canvas, the three lists, then one line
 *   only overdue                    canvas-patch on the page's to-do block; without one, list-todos
 *
 * And the runs of the module's agent templates (templates.ts); a run's message starts with the
 * agent's instructions, and what started it follows as data:
 *   Summarize my open to-dos.        list-todos → "N open to-dos:" and each
 *   Draft a follow-up note for the meeting that closed.
 *                                    list-todos of the meeting → create-note "Follow-up: <title>"
 *
 * It runs after the to-dos module's scripts (module order), so "add …", "list", "done …" and
 * "delete …" are theirs.
 */
const dueText = (ymd: unknown) => (ymd ? ` (due ${dayWords(String(ymd))})` : '');

const first = (text: string) => text.split('\n')[0]?.trim() ?? '';

/** "this one", "this meeting", "it": the meeting on screen. */
const THIS = /^(?:this(?: one| meeting)?|it)\.?$/i;

const closeCall = (meetingId: string, intent: { summary: string; items: string[] }) =>
  call('close-meeting', {
    meetingId,
    summary: intent.summary,
    decisions: [],
    actionItems: intent.items.map((title) => ({ title })),
  });

type ClosedMeeting = { record?: { id?: string; title?: string } };

export const meetingsScripts = [
  defineScript({
    name: 'agent-weekly-todos',
    match: (text) => (/^summarize my open to-dos\.?$/i.test(first(text)) ? true : undefined),
    step: (_, turn) => {
      const r = turn.result('list-todos');
      if (!r) return [call('list-todos', { done: false, sort: 'dueOn' })];
      if (!r.ok) return [say("I couldn't read the to-dos.")];
      const todos = items(r);
      if (!todos.length) return [say('No open to-dos this week.')];
      return [
        say(
          [
            `${plural(todos.length, 'open to-do')}:`,
            ...todos.map((t) => `- ${t.title}${dueText(t.dueOn)}`),
          ].join('\n'),
        ),
      ];
    },
  }),
  defineScript({
    name: 'agent-follow-up',
    match: (text) =>
      /^draft a follow-up note for the meeting that closed\.?$/i.test(first(text))
        ? text
        : undefined,
    step: (text, turn) => {
      const meeting = (runData(text) as ClosedMeeting | undefined)?.record;
      if (!meeting?.id) return [say('No meeting in what started this run.')];
      const todos = turn.result('list-todos');
      if (!todos)
        return [call('list-todos', { meetingId: meeting.id, done: false, sort: 'title' })];
      const open = items(todos);
      const note = turn.result('create-note');
      if (!note)
        return [
          call('create-note', {
            title: `Follow-up: ${meeting.title}`,
            body: [
              `Follow-up for ${meeting.title}.`,
              ...(open.length
                ? ['', '## Open to-dos', ...open.map((t) => `- ${t.title}${dueText(t.dueOn)}`)]
                : ['', 'Nothing is left open.']),
            ].join('\n'),
            meetingId: meeting.id,
          }),
        ];
      return [
        say(
          written(
            note,
            () => `Drafted a follow-up for ${meeting.title}: ${plural(open.length, 'open to-do')}.`,
            turn,
          ),
        ),
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
      const name = THIS.test(intent.title) ? 'the meeting' : intent.title;
      const r = turn.result('close-meeting');
      // The run went on after the close was approved: what is left to follow up.
      if (r && decided(r) === 'approved') {
        const meetingId = (r.result as { approval?: { resourceId?: string | null } }).approval
          ?.resourceId;
        const todos = turn.result('list-todos');
        if (!todos && meetingId)
          return [call('list-todos', { meetingId, done: false, sort: 'title' })];
        const n = items(todos).length;
        return [say(`Closed ${name}. ${plural(n, 'to-do')} to follow up.`)];
      }
      if (r) return [say(written(r, () => `Closed ${name}.`, turn))];
      // "close this one" on a meeting: the screen names it, so there is nothing to look up.
      const here = turn.record?.type === 'meeting' && THIS.test(intent.title);
      if (here && turn.record) return [closeCall(turn.record.id, intent)];
      if (THIS.test(intent.title))
        return [say('Which meeting? Open it first, or name it: "close Site review".')];
      const list = turn.result('list-meetings');
      if (!list) return [call('list-meetings', { q: intent.title })];
      const meeting = items(list).find((x) => sameTitle(x.title, intent.title)) ?? items(list)[0];
      if (!meeting) return [say(`I couldn't find a meeting called "${intent.title}".`)];
      return [closeCall(meeting.id, intent)];
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
