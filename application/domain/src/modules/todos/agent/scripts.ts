import {
  call,
  dayWords,
  defineScript,
  fileLineId,
  items,
  plural,
  sameTitle,
  say,
  sayIn,
  verbs,
  written,
} from '@hykr/agents/script';
import { pick } from '@hykr/i18n';

/**
 * The scripted model's knowledge of the to-dos module (for tests, CI and demos without a key):
 *   add <title>                     create-todo
 *   list                            list-todos
 *   done <title>                    list-todos → update-todo { done: true }
 *   delete <title>                  list-todos → delete-todo (parked for approval)
 *   what's due this week            list-todos due within 7 days → one line (the view shows them)
 *   clear done to-dos               clear-done-todos (when the business has todos.clear-done on)
 *   add this bill + a photo         read-file → create-todo "Pay <vendor>" with its cost (waits)
 *
 * Add, list, done and delete also take Hindi and Telugu verbs, before or after the title
 * ("జోడించు Call the plumber", "Order tiles हटाओ"), and answer in the turn's language.
 */
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

/** A bill as the scripted vision model reads it: "Amount: 1250 Vendor: Sharma Hardware". */
export function billOf(text: string): { amount: number; vendor: string } | undefined {
  const amount = /Amount:\s*(?:Rs\.?|₹|INR)?\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)/i.exec(text)?.[1];
  const vendor = /Vendor:\s*(.+?)\s*(?:$|\n|Date:)/i.exec(text)?.[1];
  if (!amount || !vendor) return undefined;
  return { amount: Number(amount.replace(/,/g, '')), vendor };
}

export const todosScripts = [
  // A photo of a bill with "add this bill": read it, then add a to-do to pay it, with its cost.
  // The assistant's to-do with a cost waits for the person (todo.ts).
  defineScript({
    name: 'bill',
    match: (text) =>
      /^(add|log|save) (this|the) bill\b/iu.test(first(text)) ? fileLineId(text) : undefined,
    step: (id, turn) => {
      const read = turn.result('read-file');
      if (!read)
        return [call('read-file', { id, question: 'The amount to pay, and who it is to' })];
      const bill = billOf((read.result as { text: string }).text);
      if (!bill)
        return [
          say(
            pick(
              {
                en: "I couldn't find an amount and a shop on that bill.",
                hi: 'इस बिल पर रकम और दुकान नहीं मिली।',
                te: 'ఈ బిల్లులో మొత్తం, దుకాణం కనిపించలేదు.',
              },
              turn.lang,
            ),
          ),
        ];
      const r = turn.result('create-todo');
      if (!r)
        return [
          call('create-todo', {
            title: `Pay ${bill.vendor}`,
            cost: Math.round(bill.amount * 100),
          }),
        ];
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
    name: 'add',
    match: (text) => command(VERBS.add, text),
    step: (title, turn) => {
      const r = turn.result('create-todo');
      if (!r) return [call('create-todo', { title })];
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
    // Only when the business switched "clear done to-dos" on: off, the tool is not offered, and
    // the scripted model answers for it ("I can't do that here.").
    name: 'clear-done',
    match: (text) =>
      /^clear (?:the |my )?done(?: to-?dos)?\.?$/i.test(first(text)) ? true : undefined,
    step: (_, turn) => {
      const r = turn.result('clear-done-todos');
      if (!r) return [call('clear-done-todos', {})];
      const cleared = (v: { cleared?: number }) =>
        pick(
          {
            en: `Cleared ${plural(v.cleared ?? 0, 'done to-do')}.`,
            hi: `${v.cleared ?? 0} पूरे हुए काम हटा दिए।`,
            te: `${v.cleared ?? 0} పూర్తయిన పనులను తొలగించాను.`,
          },
          turn.lang,
        );
      return [say(written(r, cleared as never, turn))];
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
      const list = todos.map((t) => `[${t.done ? 'x' : ' '}] ${t.title}`).join('\n');
      // Typed in Hindi or Telugu: a line in their language before the titles (which are data).
      if (turn.lang === 'en') return [say(list)];
      const lead = { en: 'Your to-dos:', hi: 'आपके काम ये हैं:', te: 'మీ పనులు ఇవి:' };
      return [say(`${pick(lead, turn.lang)}\n${list}`)];
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
            ? pick(
                {
                  en: `Updated ${quoted(t.title)}.`,
                  hi: `${quoted(t.title)} पूरा हो गया।`,
                  te: `${quoted(t.title)} పూర్తి చేశాను.`,
                },
                turn.lang,
              )
            : pick({ en: 'Deleted.', hi: 'हटा दिया।', te: 'తొలగించాను.' }, turn.lang);
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
];
