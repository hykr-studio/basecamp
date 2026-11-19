// Comments and the in-app inbox (B16) as an application extends them: a subscriber that hears
// each `comment.mentioned` (the agents' @-mention trigger), a mention kind of its own, a level
// rule on comments (added and edited alike) and a notification that leaves an item in the inbox.
// Only the comments e2e test boots `commentsApp`.
import { defineModule, defineServer, defineSubscriber, type MentionKind } from '@hykr/api';
import {
  commentWriteOf,
  type DomainEventEnvelope,
  defineApprovalLevel,
  moduleSpec,
} from '@hykr/contracts';
import { atLevel, defineLevelRule } from '@hykr/core';
import { defineNotification, type Row } from '@hykr/notifications';
import { fixture } from '../../index.js';

/** Every `comment.mentioned` the worker relayed, in this process. */
export const heard: DomainEventEnvelope[] = [];

export const MentionHeard = defineSubscriber({
  name: 'fixture.mentions',
  on: ['comment.mentioned'],
  handle: async (event) => {
    heard.push(event);
  },
});

/** Helpers: anything whose id starts with "helper" may be named, as "Helper <n>". */
export const HelperMentions: MentionKind = {
  kind: 'helper',
  resolve: async ({ ids }) =>
    new Map(ids.filter((id) => id.startsWith('helper')).map((id) => [id, `Helper ${id.slice(6)}`])),
  suggest: async ({ q }) =>
    'helper'.startsWith(q.toLowerCase()) ? [{ id: 'helper1', label: 'Helper 1' }] : [],
};

/**
 * Reaches a helper, someone outside the business: waits when the assistant does it, and a
 * business may make it always wait (settings `approvals.levels.fixture_helpers.parks`).
 */
export const HelpersLevel = defineApprovalLevel({
  name: 'fixture_helpers',
  rank: 2,
  label: { en: 'Helpers', hi: 'Helpers', te: 'Helpers' },
  policy: { parks: (p) => p.actor.kind !== 'user' },
});

/** A comment that names a helper, added or edited, is at the helpers' level. */
export const HelperCommentLevels = defineLevelRule({
  name: 'fixture.helper-comments',
  on: ['comment.add', 'comment.edit'],
  decide: (a) =>
    commentWriteOf(a)?.mentions.some((m) => m.kind === 'helper')
      ? atLevel(HelpersLevel.name, 'names_a_helper', 'A helper is told')
      : null,
});

type TaskRow = Row & { title: string; ownerId: string };

/** A task titled "Inbox…" leaves an item in its owner's inbox. */
export const TaskInboxed = defineNotification<TaskRow>({
  key: 'task.inboxed',
  topic: 'service',
  send: { on: ['task.created'] },
  when: (t) => t.title.startsWith('Inbox'),
  to: (t) => [{ userId: t.ownerId }],
  channels: ['inapp'],
  inapp: {
    title: (t, r) => `New task: ${t.title} (${r.lang})`,
    body: () => 'It was added.',
    url: (t) => `/tasks/${t.id}`,
    record: (t) => ({ type: 'task', id: t.id }),
  },
  dedupe: (t) => `task.inboxed:${t.id}`,
});

export const commentingModule = defineModule({
  ...moduleSpec({ name: 'commenting', dependsOn: ['tasks'], entities: {}, commands: [] }),
  notifications: [TaskInboxed],
});

/** The fixture, with the subscriber, the mention kind, the level and the notification above. */
export const commentsApp = defineServer({
  ...fixture.definition,
  modules: [...fixture.definition.modules, commentingModule],
  contributes: {
    subscribers: [MentionHeard],
    mentionKinds: [HelperMentions],
    approvalLevels: [HelpersLevel],
    levelRules: [HelperCommentLevels],
  },
});
