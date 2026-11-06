// Push (A9) as an application uses it: a notification that goes by push first, then by email.
// Only the push e2e test boots `pushApp`.
import { defineModule, defineServer } from '@hykr/api';
import { moduleSpec } from '@hykr/contracts';
import { defineNotification, type Row } from '@hykr/notifications';
import { fixture } from '../../index.js';

type TaskRow = Row & { title: string; ownerId: string };

/** A task titled "Push…", to its owner: by push, else by email. */
export const PushedNotification = defineNotification<TaskRow>({
  key: 'task.pushed',
  topic: 'service',
  send: { on: ['task.created'] },
  when: (t) => t.title.startsWith('Push'),
  to: (t) => [{ userId: t.ownerId }],
  channels: ['push', 'email'],
  push: {
    title: (t) => `Task: ${t.title}`,
    body: (t, r) => `${t.title} was added (${r.lang}).`,
    url: () => '/tasks',
  },
  email: { subject: (t) => `Pushed: ${t.title}`, body: (t) => `${t.title} was added.` },
  dedupe: (t) => `task.pushed:${t.id}`,
});

export const pushModule = defineModule({
  ...moduleSpec({ name: 'pushing', dependsOn: ['tasks'], entities: {}, commands: [] }),
  notifications: [PushedNotification],
});

/** The fixture, with the notification above. */
export const pushApp = defineServer({
  ...fixture.definition,
  modules: [...fixture.definition.modules, pushModule],
});
