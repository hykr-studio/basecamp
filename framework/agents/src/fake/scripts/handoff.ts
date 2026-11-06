// A person takes over:
//   Draft a reply …              a short reply for staff to edit (the back office)
//   talk to the manager          request-human (a person takes the WhatsApp conversation)
import { call, defineScript, say } from '../engine.js';
import { defineScriptSet } from '../script-set.js';

export const handoffScripts = defineScriptSet({
  name: 'handoff',
  order: 200,
  scripts: [
    // Before request-human: a draft's transcript may hold "talk to a person".
    defineScript({
      name: 'draft-reply',
      match: (text) => (/^Draft a reply to this customer/i.test(text) ? true : undefined),
      step: () => [
        say('Thank you for your message. We are looking into it and will reply shortly.'),
      ],
    }),
    defineScript({
      name: 'request-human',
      match: (text) =>
        /\b(?:talk|speak) to (?:the |a )?(manager|owner|person|human|someone)\b/i.exec(text)?.[1],
      step: (who, turn) => {
        const asked = turn.result('request-human');
        if (!asked) return [call('request-human', { reason: `They asked for the ${who}` })];
        return [say("I've asked the team. Someone will reply to you here.")];
      },
    }),
  ],
});
