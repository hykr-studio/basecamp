import { call, defineScript, items, type Row, say } from './engine.js';

/**
 * Scripts for the framework's own features, in every domain:
 *   save this as <name>          create-page with the page on the canvas
 *   open my <name> page|view     list-pages → canvas-open (screen page.view)
 *   talk to the manager          request-human (a person takes the WhatsApp conversation)
 *   Draft a reply …              a short reply for staff to edit (the back office)
 *   FAIL THIS TURN               the model errors (tests of what happens when a turn fails)
 */
export const platformScripts = [
  defineScript({
    name: 'save-page',
    match: (text) => /^save (?:this|it) as (?:my )?["“]?(.+?)["”]?\.?$/i.exec(text)?.[1],
    step: (name, turn) => {
      if (!turn.canvas || !turn.surfaces.includes('canvas'))
        return [say('There is no page to save yet. Ask me for an overview first.')];
      if (!turn.result('create-page')) return [call('create-page', { name, spec: turn.canvas })];
      return [say(`Saved "${name}". It is under Pages.`)];
    },
  }),
  defineScript({
    name: 'open-page',
    match: (text) => /^open my (.+?) (?:page|view)\.?$/i.exec(text)?.[1],
    step: (name, turn) => {
      const pages = turn.result('list-pages');
      if (!pages) return [call('list-pages', { q: name })];
      const page = items(pages)[0] as (Row & { name?: string }) | undefined;
      if (!page) return [say(`I couldn't find a page called "${name}".`)];
      if (!turn.surfaces.includes('canvas'))
        return [say(`"${page.name}" is a page; open the app to see it.`)];
      if (!turn.result('canvas-open'))
        return [call('canvas-open', { screen: 'page.view', params: { id: page.id } })];
      return [say(`Opened "${page.name}".`)];
    },
  }),
  // Before request-human: a draft's transcript may hold "talk to a person".
  defineScript({
    name: 'draft-reply',
    match: (text) => (/^Draft a reply to this customer/i.test(text) ? true : undefined),
    step: () => [say('Thank you for your message. We are looking into it and will reply shortly.')],
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
  defineScript({
    name: 'fail',
    match: (text) => (/^FAIL THIS TURN$/.test(text.trim()) ? true : undefined),
    step: () => {
      throw new Error('Scripted failure');
    },
  }),
];
