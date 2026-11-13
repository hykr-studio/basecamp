import {
  call,
  defineScript,
  items,
  type Outcome,
  sameTitle,
  say,
  sayIn,
  type Turn,
  verbs,
  written,
} from '@hykr/agents/script';
import { pick } from '@hykr/i18n';

/**
 * The scripted model's knowledge of the briefs module (tests, CI and demos without a key):
 *   new brief <name>: <need>[, budget <amount> <CUR>]   create-brief
 *   list briefs                            list-briefs
 *   new briefs                             list-briefs, the new ones only
 *   mark brief <name> reviewed             list-briefs → update-brief { status: reviewed }
 *   drop brief <name>                      list-briefs → delete-brief (waits for approval)
 *
 * "New brief" and "list briefs" also take Hindi and Telugu ("नया ब्रीफ़ Meena: a new wardrobe",
 * "ब्रीफ़ दिखाओ"), and every answer comes in the turn's language. The verbs are this module's
 * own: the to-dos module's "add …", "delete …" and "list" come first in module order.
 *
 * A brief carries a currency (its budget's), and a create names one: the framework takes none
 * from the business for a plain create. With no budget given, the create is refused and the
 * assistant says so; it never picks a currency itself.
 */
const first = (text: string) => text.split('\n')[0]?.trim() ?? '';
const quoted = (name: string) => `"${name}"`;

const NEW = new RegExp(
  `^(?:${verbs('new brief', 'नया ब्रीफ़', 'नया ब्रीफ', 'కొత్త బ్రీఫ్')})\\s+(.+?):\\s*(.+?)(?:,\\s*budget\\s+(\\d+(?:\\.\\d{1,3})?)\\s+([A-Z]{3}))?$`,
  'iu',
);
const LIST = new RegExp(
  `^(?:${verbs('list briefs', 'ब्रीफ़ दिखाओ', 'ब्रीफ दिखाओ', 'బ్రీఫ్‌లు చూపించు', 'బ్రీఫ్లు చూపించు')})$`,
  'iu',
);
const FRESH = /^(?:which briefs are new|new briefs)\??$/i;
const REVIEWED = /^mark brief (.+?) (?:as )?reviewed\.?$/i;
const DROP = /^drop brief (.+?)\.?$/i;

type Brief = { id: string; name: string; summary: string; status: string };

const noSuchBrief = (turn: Pick<Turn, 'lang'>, name: string) =>
  sayIn(turn, {
    en: `I couldn't find a brief from ${quoted(name)}.`,
    hi: `${quoted(name)} का कोई ब्रीफ़ नहीं मिला।`,
    te: `${quoted(name)} బ్రీఫ్ దొరకలేదు.`,
  });

/** The briefs as words: the spoken gist the server worded, or one line each on a screen. */
function listed(turn: Turn, r: Outcome) {
  if (turn.spoken && r.speech) return [say(r.speech)];
  const briefs = items(r) as unknown as Brief[];
  if (briefs.length === 0)
    return [
      sayIn(turn, {
        en: 'There are no briefs.',
        hi: 'कोई ब्रीफ़ नहीं है।',
        te: 'బ్రీఫ్‌లు ఏవీ లేవు.',
      }),
    ];
  const lines = briefs.map((b) => `• ${b.name}: ${b.summary}`).join('\n');
  // Names and needs are data, as the customer gave them; the line before them is the turn's.
  if (turn.lang === 'en') return [say(lines)];
  const lead = { en: 'Your briefs:', hi: 'आपके ब्रीफ़ ये हैं:', te: 'మీ బ్రీఫ్‌లు ఇవి:' };
  return [say(`${pick(lead, turn.lang)}\n${lines}`)];
}

export const briefsScripts = [
  defineScript({
    name: 'new-brief',
    match: (text) => {
      const m = NEW.exec(first(text));
      if (!m) return undefined;
      const budget = m[3] ? { budget: m[3], currency: m[4].toUpperCase() } : {};
      return { name: m[1].trim(), summary: m[2].trim(), budget };
    },
    step: ({ name, summary, budget }, turn) => {
      const r = turn.result('create-brief');
      if (!r) return [call('create-brief', { name, summary, ...budget })];
      const added = () =>
        pick(
          {
            en: `Took down the brief from ${quoted(name)}.`,
            hi: `${quoted(name)} का ब्रीफ़ लिख लिया।`,
            te: `${quoted(name)} బ్రీఫ్ రాసుకున్నాను.`,
          },
          turn.lang,
        );
      return [say(written(r, added, turn))];
    },
  }),
  defineScript({
    name: 'list-briefs',
    match: (text) => (LIST.test(first(text)) ? true : undefined),
    step: (_, turn) => {
      const r = turn.result('list-briefs');
      if (!r) return [call('list-briefs', {})];
      return listed(turn, r);
    },
  }),
  defineScript({
    name: 'new-briefs',
    match: (text) => (FRESH.test(first(text)) ? true : undefined),
    step: (_, turn) => {
      const r = turn.result('list-briefs');
      if (!r) return [call('list-briefs', { status: 'new' })];
      return listed(turn, r);
    },
  }),
  defineScript({
    name: 'review-or-drop-brief',
    match: (text) => {
      const reviewed = REVIEWED.exec(first(text))?.[1];
      if (reviewed) return { verb: 'review' as const, name: reviewed };
      const dropped = DROP.exec(first(text))?.[1];
      return dropped ? { verb: 'drop' as const, name: dropped } : undefined;
    },
    step: ({ verb, name }, turn) => {
      const tool = verb === 'review' ? 'update-brief' : 'delete-brief';
      const r = turn.result(tool);
      if (r) {
        const done = () =>
          verb === 'review'
            ? pick(
                {
                  en: `Marked the brief from ${quoted(name)} reviewed.`,
                  hi: `${quoted(name)} का ब्रीफ़ देख लिया गया।`,
                  te: `${quoted(name)} బ్రీఫ్ చూసినట్టు గుర్తు పెట్టాను.`,
                },
                turn.lang,
              )
            : pick({ en: 'Dropped it.', hi: 'हटा दिया।', te: 'తీసేశాను.' }, turn.lang);
        return [say(written(r, done, turn))];
      }
      // Look first: never an invented id.
      const found = turn.result('list-briefs');
      if (!found) return [call('list-briefs', { q: name })];
      const brief = (items(found) as unknown as Brief[]).find((b) => sameTitle(b.name, name));
      if (!brief) return [noSuchBrief(turn, name)];
      return [
        call(tool, verb === 'review' ? { id: brief.id, status: 'reviewed' } : { id: brief.id }),
      ];
    },
  }),
];
