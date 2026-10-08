import type { PageSpec, Surface } from '@app/contracts';
import type { Lang } from '@app/i18n';
import type { Script } from './fake/engine.js';
import type { Expected } from './scorers.js';

/** One eval turn: what the person says, and which tools must (not) run. */
export type EvalCase = {
  input: string;
  expect: Expected;
  why: string;
  /** Where the turn can show things; default: the app (inline and canvas). */
  surfaces?: Surface[];
  /** The page on the canvas, for refinements. */
  canvas?: PageSpec;
};

/** A spoken eval turn: said in a language, answered in it, briefly, with the right tools. */
export type VoiceEvalCase = EvalCase & { lang: Lang };

/**
 * What the assistant knows about a domain, beyond its entities and commands (which come
 * from @app/contracts): who it is, the domain's working rules, and how to test it. The
 * framework (instructions, tools, the fake model, the eval runner) reads only this.
 */
export interface AgentDomain {
  /** First line of the instructions: who the assistant is. */
  persona: string;
  /** Domain rules, one "- " line each, added to the framework's rules. */
  rules: string[];
  /** The scripted model's answer when no script matches (tests and demos). */
  help: string;
  /** The scripted model's knowledge of the domain. */
  scripts: readonly Script[];
  /** One eval conversation, in order: later turns may rely on earlier ones. */
  evalCases: EvalCase[];
  /** Spoken turns in each language the product speaks, code-mixed included (evals/voice). */
  voiceEvalCases?: VoiceEvalCase[];
  /** Data the eval cases need, created through the API as the eval user. */
  evalSetup?: (
    api: (method: string, path: string, body?: unknown) => Promise<unknown>,
  ) => Promise<void>;
}
