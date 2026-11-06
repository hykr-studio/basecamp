import type { PageSpec, Surface } from '@hykr/contracts';
import type { Lang } from '@hykr/i18n';
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

/** Creates the data a module's eval cases need, through the API, as the eval user. */
export type EvalSetup = (
  api: (method: string, path: string, body?: unknown) => Promise<unknown>,
) => Promise<void>;

/**
 * What one application module teaches the assistant: its working rules, one line of help, the
 * scripted model's scripts for its verbs, and its own evals (run on their own, with a fresh user
 * and this module's setup). The application keeps the persona.
 */
export interface AgentModule {
  /** Its rules, one "- " line each, after the framework's and earlier modules'. */
  rules?: string[];
  /** One line for the scripted model's help, used when the application gives none. */
  help?: string;
  /** The scripted model's knowledge of the module; earlier modules' scripts match first. */
  scripts?: readonly Script[];
  /** One eval conversation, in order: later turns may rely on earlier ones. */
  evalCases?: EvalCase[];
  /** Spoken turns in each language the product speaks, code-mixed included (evals/voice). */
  voiceEvalCases?: VoiceEvalCase[];
  /** Data the eval cases need, created through the API as the eval user. */
  evalSetup?: EvalSetup;
}

/** One module's evals: `basecamp eval --module <module>` runs only these. */
export interface EvalSuite {
  module: string;
  evalCases: EvalCase[];
  voiceEvalCases: VoiceEvalCase[];
  evalSetup?: EvalSetup;
}

/**
 * What the assistant knows about the application, beyond its entities and commands (which come
 * from @hykr/contracts): who it is, the modules' working rules, the scripted model, and how to
 * test it. Built from the modules by `mergeAgentModules`; the framework (instructions, tools,
 * the fake model, the eval runner) reads only this.
 */
export interface AgentDomain {
  /** First line of the instructions: who the assistant is. */
  persona: string;
  /** The modules' rules, one "- " line each, added to the framework's rules. */
  rules: string[];
  /** The scripted model's answer when no script matches (tests and demos). */
  help: string;
  /** The scripted model's knowledge of the modules, in module order. */
  scripts: readonly Script[];
  /** Each module's evals, in module order. */
  suites: readonly EvalSuite[];
}
