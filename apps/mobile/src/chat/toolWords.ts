import { commands, entities } from '@app/contracts';

/**
 * A tool call in people's words, from the contracts: "list-meetings" is "Listed meetings",
 * "delete-todo" parked is "Asked to delete a to-do", "close-meeting" is "Closed a meeting".
 * Entity labels and command verbs come from their specs, so a new domain needs no wording here.
 */
export type ToolWords = {
  /** It ran: "Added a to-do". */
  did: string;
  /** It runs now: "Adding a to-do…". */
  doing: string;
  /** It waits for the person: "Asked to delete a to-do". */
  asked: string;
  /** It was refused: "Couldn't delete a to-do". */
  refused: string;
};

const ENTITY: Record<string, { do: string; did: string; plural?: boolean }> = {
  list: { do: 'list', did: 'listed', plural: true },
  get: { do: 'look up', did: 'looked up' },
  create: { do: 'add', did: 'added' },
  update: { do: 'change', did: 'changed' },
  delete: { do: 'delete', did: 'deleted' },
};

/** Tools the framework brings (the canvas), not the domain. */
const PLATFORM: Record<string, { do: string; did: string }> = {
  'canvas-open': { do: 'open it on the canvas', did: 'opened it on the canvas' },
  'canvas-compose': { do: 'compose a page', did: 'composed a page' },
  'canvas-patch': { do: 'update the page', did: 'updated the page' },
};

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const article = (label: string) => (/^[aeiou]/i.test(label) ? `an ${label}` : `a ${label}`);
/** "close" → "closing", "hand over" → "handing over", "look up" → "looking up". */
const gerund = (phrase: string) =>
  phrase.replace(/^(\w+)/, (w) => (/[^e]e$/.test(w) ? `${w.slice(0, -1)}ing` : `${w}ing`));

function words(verb: { do: string; did: string }, object: string): ToolWords {
  const tail = object ? ` ${object}` : '';
  return {
    did: cap(`${verb.did}${tail}`),
    doing: `${cap(gerund(verb.do))}${tail}…`,
    asked: `Asked to ${verb.do}${tail}`,
    refused: `Couldn't ${verb.do}${tail}`,
  };
}

export function toolWords(tool: string): ToolWords {
  const platform = PLATFORM[tool];
  if (platform) return words(platform, '');
  const command = commands.find((c) => c.tool === tool);
  if (command) {
    const [entity = '', action = tool] = command.name.split('.');
    const spec = Object.values(entities).find((s) => s.name === entity);
    const verb = command.verb ?? { do: action, did: `${action}d` };
    return words(verb, spec ? article(spec.label) : '');
  }
  const m = /^(list|get|create|update|delete)-(.+)$/.exec(tool);
  const spec = m && Object.values(entities).find((s) => s.name === m[2] || s.plural === m[2]);
  if (m && spec) {
    const verb = ENTITY[m[1]];
    return words(verb, verb.plural ? `${spec.label}s` : article(spec.label));
  }
  // Anything else still reads as a phrase: "save-page" → "Save page".
  const phrase = tool.replace(/-/g, ' ');
  return {
    did: cap(phrase),
    doing: `${cap(phrase)}…`,
    asked: `Asked: ${phrase}`,
    refused: `Couldn't ${phrase}`,
  };
}
