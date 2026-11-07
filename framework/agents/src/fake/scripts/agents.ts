// Agents (A6): the person describes a job in one line, the assistant drafts the agent.
//   create an agent to <job> [every <day>|day|weekday [at H[:MM]]] [using <tool>, <tool>]
//                                    create-agent (the person approves the draft)
//   run the agent <name>             list-agents, then run-agent
import { call, defineScript, items, say, written } from '../engine.js';
import { defineScriptSet } from '../script-set.js';

const DAYS: Readonly<Record<string, string>> = {
  sunday: '0',
  monday: '1',
  tuesday: '2',
  wednesday: '3',
  thursday: '4',
  friday: '5',
  saturday: '6',
  day: '*',
  weekday: '1-5',
};

/** The draft a line asks for: its job, a schedule if it names one, the tools it names. */
export function draftOf(line: string) {
  let job = line.trim().replace(/\.$/, '');
  let tools: string[] = [];
  const using = /\s+using\s+([a-z][a-z0-9-]*(?:\s*,\s*[a-z][a-z0-9-]*)*)$/i.exec(job);
  if (using) {
    tools = using[1].split(',').map((t) => t.trim().toLowerCase());
    job = job.slice(0, using.index);
  }
  let cron: string | undefined;
  const every = /\s+every\s+([a-z]+)(?:\s+at\s+(\d{1,2})(?::(\d{2}))?)?/i.exec(job);
  const dow = every ? DAYS[every[1].toLowerCase()] : undefined;
  if (every && dow) {
    const hour = Math.min(23, Number(every[2] ?? 9));
    const minute = Math.min(59, Number(every[3] ?? 0));
    cron = `${minute} ${hour} * * ${dow}`;
    job = `${job.slice(0, every.index)}${job.slice(every.index + every[0].length)}`.trim();
  }
  const words = job.charAt(0).toUpperCase() + job.slice(1);
  const name = words.length > 60 ? `${words.slice(0, 59)}…` : words;
  return {
    name,
    instructions: `${words}.`,
    triggers: cron ? [{ kind: 'recurring', cron }] : [],
    scope: { tools },
  };
}

export const agentsScripts = defineScriptSet({
  name: 'agents',
  order: 330,
  scripts: [
    defineScript({
      name: 'agents-create',
      match: (text) =>
        /^(?:create|make|set up) an agent (?:to|that) (.+)$/is.exec(text.trim())?.[1],
      step: (line, turn) => {
        const draft = draftOf(line);
        const r = turn.result('create-agent');
        if (!r) return [call('create-agent', draft)];
        if (!r.ok) return [say(`I couldn't draft that agent.`)];
        return [say(written(r, () => `Created the agent "${draft.name}".`, turn))];
      },
    }),
    defineScript({
      name: 'agents-run',
      match: (text) => /^run (?:the|my) agent (.+?)\.?$/i.exec(text.trim())?.[1],
      step: (name, turn) => {
        const list = turn.result('list-agents');
        if (!list) return [call('list-agents', { q: name })];
        const agent = items(list)[0];
        if (!agent) return [say(`I couldn't find an agent called "${name}".`)];
        const r = turn.result('run-agent');
        if (!r) return [call('run-agent', { agentId: agent.id })];
        if (!r.ok) return [say(`I couldn't run "${agent.name}".`)];
        return [say(`Started "${agent.name}". Its run log will say what it did.`)];
      },
    }),
  ],
});
