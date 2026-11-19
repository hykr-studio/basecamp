// Web push (W1) as an application uses it: chores (the write-path fixture's entity, with its
// due date hidden from staff and an undo window on "done") whose notifications go to the
// person's browsers, then by email. Only the web push e2e test boots `webPushApp`.
import { defineModule, defineServer } from '@hykr/api';
import { moduleSpec } from '@hykr/contracts';
import { defineNotification, type Row } from '@hykr/notifications';
import { fixture } from '../../index.js';
import { choresModule, writePathContributions } from '../write-path/index.js';

type ChoreRow = Row & { title: string; ownerId: string; dueOn?: string | null; done?: boolean };

const push = {
  title: (c: ChoreRow) => `Chore: ${c.title}`,
  // The due date is hidden from staff (field policy): their push never names it.
  body: (c: ChoreRow) => `${c.title} is due ${c.dueOn ?? 'some day'}.`,
  url: (c: ChoreRow) => `/chores/${c.id}`,
};
const email = {
  subject: (c: ChoreRow) => `Chore: ${c.title}`,
  body: (c: ChoreRow) => `${c.title} was added.`,
};

/** A chore titled "Web…", to its owner: by their browsers, else by email. Quiet hours apply. */
export const WebPushedNotification = defineNotification<ChoreRow>({
  key: 'chore.webpushed',
  topic: 'reminders',
  send: { on: ['chore.created'] },
  when: (c) => c.title.startsWith('Web'),
  to: (c) => [{ userId: c.ownerId }],
  channels: ['webpush', 'email'],
  push,
  email,
  dedupe: (c) => `chore.webpushed:${c.id}`,
});

/** A chore titled "Both…": `push`, the shorthand (phones, then browsers), else email. */
export const BothPushedNotification = defineNotification<ChoreRow>({
  key: 'chore.bothpushed',
  topic: 'service',
  send: { on: ['chore.created'] },
  when: (c) => c.title.startsWith('Both'),
  to: (c) => [{ userId: c.ownerId }],
  channels: ['push', 'email'],
  push,
  email,
  dedupe: (c) => `chore.bothpushed:${c.id}`,
});

/** A chore titled "Undo…" marked done (a write with an undo window): to its owner's browsers. */
export const DoneNotification = defineNotification<ChoreRow>({
  key: 'chore.done',
  topic: 'service',
  send: { on: ['chore.updated'] },
  when: (c) => c.title.startsWith('Undo') && c.done === true,
  to: (c) => [{ userId: c.ownerId }],
  channels: ['webpush', 'email'],
  push: { ...push, title: (c: ChoreRow) => `Done: ${c.title}` },
  email,
  dedupe: (c) => `chore.done:${c.id}`,
});

export const webPushModule = defineModule({
  ...moduleSpec({ name: 'webpushing', dependsOn: ['chores'], entities: {}, commands: [] }),
  notifications: [WebPushedNotification, BothPushedNotification, DoneNotification],
});

/** The fixture, with chores and the notifications above. */
export const webPushApp = defineServer({
  ...fixture.definition,
  modules: [...fixture.definition.modules, choresModule, webPushModule],
  contributes: writePathContributions,
});
