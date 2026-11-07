import type { EvalCase } from '@hykr/agents/script';

/** The notes module's evals (`basecamp eval --module notes`): recall by meaning. */
export const evalCases: EvalCase[] = [
  {
    why: 'recalls a note by meaning, not by its title',
    input: 'what do you remember about the splash-back?',
    expect: { must: ['recall-memory'], mustNot: ['create-note'], replyIncludes: 'teal' },
  },
];
