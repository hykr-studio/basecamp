import type { EvalCase, VoiceEvalCase } from '@hykr/agents/script';

/** The notes module's evals (`basecamp eval --module notes`): recall by meaning. */
export const evalCases: EvalCase[] = [
  {
    why: 'recalls a note by meaning, not by its title',
    input: 'what do you remember about the splash-back?',
    expect: { must: ['recall-memory'], mustNot: ['create-note'], replyIncludes: 'teal' },
  },
];

/**
 * Spoken turns in English, Hindi and Telugu: what was noted comes back as it was written, the
 * words around it in the turn's language. The ones not in English are typed on WhatsApp too.
 */
export const voiceEvalCases: VoiceEvalCase[] = [
  {
    lang: 'en',
    why: 'recalls by meaning (English)',
    input: 'what do you remember about the splash-back?',
    expect: { must: ['recall-memory'], mustNot: ['create-note'], replyIncludes: 'teal' },
  },
  {
    lang: 'hi',
    why: 'recalls by meaning (Hindi)',
    input: 'splash-back के बारे में क्या याद है?',
    expect: { must: ['recall-memory'], mustNot: ['create-note'], replyIncludes: 'teal' },
  },
  {
    lang: 'te',
    why: 'recalls by meaning (Telugu)',
    input: 'splash-back గురించి ఏమి గుర్తుంది?',
    expect: { must: ['recall-memory'], mustNot: ['create-note'], replyIncludes: 'teal' },
  },
];
