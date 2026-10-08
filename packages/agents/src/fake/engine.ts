import type {
  LanguageModelV2,
  LanguageModelV2CallOptions,
  LanguageModelV2Content,
  LanguageModelV2Prompt,
  LanguageModelV2StreamPart,
} from '@ai-sdk/provider';
import { LANG_ENGLISH_NAMES, LANGS, type Labels, type Lang, pick, scriptOf, t } from '@app/i18n';

/**
 * A scripted model for tests and CI: the real agent loop, no network, no cost. The engine
 * reads the turn (the message, the tool results so far, the person's time zone, where they
 * can see things, the page on the canvas); scripts decide the next step, like a model would.
 * The domain brings its own scripts (src/domain); the framework's live in platform-scripts.
 */
export type Row = Record<string, unknown> & { id: string; title: string };
/** A tool's result as the model sees it; `speech` on a spoken turn (see core present.ts). */
export type Outcome = {
  ok: boolean;
  result?: unknown;
  status?: number;
  error?: unknown;
  speech?: string;
};
export type Step = { toolName: string; outcome: Outcome };
export type CanvasPage = {
  title: string;
  blocks: { id: string; view: string; query?: Record<string, unknown> }[];
};

/** Everything a script can read about the turn so far. */
export type Turn = {
  /** The person's last message. */
  text: string;
  steps: Step[];
  /** The first result of this tool in the turn, if it ran. */
  result: (tool: string) => Outcome | undefined;
  zone: string;
  /** Today in the person's zone, YYYY-MM-DD. */
  today: string;
  surfaces: string[];
  canvas?: CanvasPage;
  /** The language to answer in: as the instructions pin it, or the script the person wrote in. */
  lang: Lang;
  /** A voice turn: say the gist, the screen shows the rest. */
  spoken: boolean;
  /** The record the person is looking at, as the instructions state it ("close this one"). */
  record?: { type: string; id: string };
};

/** One thing the scripted model knows how to do. The first script that matches runs. */
export type Script<I = unknown> = {
  name: string;
  match: (text: string) => I | undefined;
  step: (intent: I, turn: Turn) => LanguageModelV2Content[];
};
export const defineScript = <I>(script: Script<I>): Script<unknown> => script as Script<unknown>;

/* ── Helpers scripts use ─────────────────────────────────────────────────── */

let callCounter = 0;
export const call = (toolName: string, args: unknown): LanguageModelV2Content => ({
  type: 'tool-call',
  toolCallId: `call_${++callCounter}`,
  toolName,
  input: JSON.stringify(args),
});
export const say = (value: string): LanguageModelV2Content => ({ type: 'text', text: value });
/** A reply in the turn's language. */
export const sayIn = (turn: Pick<Turn, 'lang'>, words: Labels): LanguageModelV2Content =>
  say(pick(words, turn.lang));
/**
 * Verbs in any of the product's languages, as one alternation: `^(?:add|जोड़ो)`. Text is
 * compared in NFC (the agent's input processor normalizes Unicode), so the verbs are too.
 */
export const verbs = (...words: string[]) => words.map((w) => w.normalize('NFC')).join('|');

export const items = (o?: Outcome) =>
  ((o?.result as { items?: Row[] } | undefined)?.items ?? []) as Row[];
export const sameTitle = (a: string, b: string) =>
  a.trim().toLowerCase() === b.trim().toLowerCase();
export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** A date as people write it: "5 Oct", not "2026-10-05". */
export const dayWords = (ymd: string) =>
  new Date(`${ymd}T00:00:00Z`).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  });

/** The instant at which `day` (YYYY-MM-DD) starts in `zone`. */
export function startOfDay(day: string, zone: string): Date {
  const utc = new Date(`${day}T00:00:00Z`);
  const wall = (d: Date, tz: string) =>
    new Date(d.toLocaleString('en-US', { timeZone: tz })).getTime();
  return new Date(utc.getTime() - (wall(utc, zone) - wall(utc, 'UTC')));
}

/**
 * What a finished write says: done, or what is waiting for approval. Spoken, or in another
 * language, the waiting line is the framework's short one: the card on screen has the detail.
 */
export function written(
  o: Outcome,
  done: (value: Row) => string,
  turn?: Pick<Turn, 'lang' | 'spoken' | 'surfaces'>,
): string {
  const r = o.result as { status: string; value?: Row; approval?: { summary: string | null } };
  if (r.status === 'needs_approval') {
    if (turn && (turn.spoken || turn.lang !== 'en')) {
      // "It's on screen" only where there is one; otherwise where to approve it.
      const screen = turn.surfaces.some((s) => s === 'inline' || s === 'canvas');
      return screen
        ? t(turn.lang, 'said.needsApproval')
        : t(turn.lang, 'said.waitingApproval', {
            summary: r.approval?.summary ?? t(turn.lang, 'said.aChange'),
          });
    }
    return `I've asked for your approval: ${r.approval?.summary ?? 'see Approvals'}. Nothing changes until you approve it.`;
  }
  return done(r.value as Row);
}

/* ── Reading the prompt ──────────────────────────────────────────────────── */

function fromSystem<T>(prompt: LanguageModelV2Prompt, re: RegExp, read: (m: RegExpExecArray) => T) {
  for (const message of prompt) {
    if (message.role !== 'system') continue;
    const m = re.exec(message.content);
    if (m) return read(m);
  }
  return undefined;
}

function lastUserText(prompt: LanguageModelV2Prompt): string {
  for (let i = prompt.length - 1; i >= 0; i--) {
    const message = prompt[i];
    if (message.role !== 'user') continue;
    return message.content
      .map((part) => (part.type === 'text' ? part.text : ''))
      .join('\n')
      .trim();
  }
  return '';
}

/** Tool results since the last user message, oldest first. */
function stepsThisTurn(prompt: LanguageModelV2Prompt): Step[] {
  const steps: Step[] = [];
  for (let i = prompt.length - 1; i >= 0 && prompt[i].role !== 'user'; i--) {
    const message = prompt[i];
    if (message.role !== 'tool') continue;
    for (const part of [...message.content].reverse()) {
      const output = part.output as { value: unknown };
      steps.unshift({ toolName: part.toolName, outcome: output.value as Outcome });
    }
  }
  return steps;
}

/** "Reply in Telugu." → 'te': the instruction line as assistant.ts writes it, from one list. */
const PINNED = new Map<string, Lang>(LANGS.map((l) => [LANG_ENGLISH_NAMES[l], l]));
const PIN_LINE = new RegExp(`^Reply in (${[...PINNED.keys()].join('|')})\\.`, 'm');

function turnOf(prompt: LanguageModelV2Prompt): Turn {
  const steps = stepsThisTurn(prompt);
  // As the instructions state them (see INSTRUCTIONS in version.ts).
  const zone = fromSystem(prompt, /time zone is ([A-Za-z0-9_+\-/]+)/, (m) => m[1]) ?? 'UTC';
  const text = lastUserText(prompt).normalize('NFC');
  return {
    text,
    lang: fromSystem(prompt, PIN_LINE, (m) => PINNED.get(m[1])) ?? scriptOf(text) ?? 'en',
    spoken: fromSystem(prompt, /This turn is spoken/, () => true) ?? false,
    steps,
    result: (tool) => steps.find((s) => s.toolName === tool)?.outcome,
    zone,
    today: new Date().toLocaleDateString('sv', { timeZone: zone }),
    surfaces: fromSystem(prompt, /Surfaces: ([a-z, ]+)\./, (m) =>
      m[1].split(',').map((s) => s.trim()),
    ) ?? ['inline'],
    canvas: fromSystem(prompt, /The canvas shows this page: (\{.*\})\s*$/m, (m) =>
      JSON.parse(m[1]),
    ),
    record: fromSystem(prompt, /The user is looking at ([a-z_]+) ([0-9a-f-]{36})\./, (m) => ({
      type: m[1],
      id: m[2],
    })),
  };
}

const why = (o: Outcome) => {
  const body = o.error as { reason?: string; message?: unknown } | null;
  return (
    body?.reason ??
    (typeof body?.message === 'string' ? body.message : `the API answered ${o.status}`)
  );
};

/** Decide the next step from the conversation so far. */
export function runScripts(
  prompt: LanguageModelV2Prompt,
  scripts: readonly Script[],
  help: string,
): LanguageModelV2Content[] {
  const turn = turnOf(prompt);
  const last = turn.steps.at(-1);
  if (last && !last.outcome.ok)
    return [say(t(turn.lang, 'said.couldNot', { reason: why(last.outcome) }))];
  for (const script of scripts) {
    const intent = script.match(turn.text);
    if (intent !== undefined) return script.step(intent, turn);
  }
  return [say(help)];
}

const usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

export function fakeModel(scripts: readonly Script[], help: string): LanguageModelV2 {
  return {
    specificationVersion: 'v2',
    provider: 'fake',
    modelId: 'scripted',
    supportedUrls: {},

    async doGenerate(options: LanguageModelV2CallOptions) {
      const content = runScripts(options.prompt, scripts, help);
      const calledTool = content.some((part) => part.type === 'tool-call');
      return { content, finishReason: calledTool ? 'tool-calls' : 'stop', usage, warnings: [] };
    },

    async doStream(options: LanguageModelV2CallOptions) {
      const content = runScripts(options.prompt, scripts, help);
      const calledTool = content.some((part) => part.type === 'tool-call');
      const parts: LanguageModelV2StreamPart[] = [{ type: 'stream-start', warnings: [] }];
      for (const part of content) {
        if (part.type === 'text') {
          parts.push(
            { type: 'text-start', id: 't1' },
            { type: 'text-delta', id: 't1', delta: part.text },
            { type: 'text-end', id: 't1' },
          );
        } else if (part.type === 'tool-call') {
          parts.push(part);
        }
      }
      parts.push({ type: 'finish', finishReason: calledTool ? 'tool-calls' : 'stop', usage });
      return {
        stream: new ReadableStream<LanguageModelV2StreamPart>({
          start(controller) {
            for (const part of parts) controller.enqueue(part);
            controller.close();
          },
        }),
      };
    },
  };
}
