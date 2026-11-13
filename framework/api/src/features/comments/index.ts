// Comments and @-mentions (B16): comments on any record a person can read, written by the
// comment commands through the write path, read at /api/comments; `comment.mentioned` events
// (the agents' @-mention trigger) that the in-app inbox and applications' notifications follow;
// live announcements to the record's readers; erasure and export. docs/decisions/B16.md.
import { commandController, commandHandler } from '@hykr/core';
import { defineFeature } from '../feature.js';
import '../live/resources.js';
import type { LiveResource } from '../live/resources.js';
import { AddComment, EditComment, RemoveComment } from './commands.js';
import { CommentsController } from './comments.controller.js';
import { CommentsService, UserMentions } from './comments.service.js';
import './mention-kinds.js';
import { CommentsErasure, CommentsExport } from './privacy.js';
import { commentsTools } from './tools.js';

/** A comment event reaches the streams of people who may read that comment now. */
export const CommentLive: LiveResource = {
  type: 'comment',
  visible: (p, id, ctx) => ctx.get(CommentsService).visible(p, id),
};

export const commentsFeature = defineFeature({
  name: 'comments',
  controllers: [
    CommentsController,
    commandController(AddComment),
    commandController(EditComment),
    commandController(RemoveComment),
  ],
  providers: [
    CommentsService,
    UserMentions,
    commandHandler(AddComment),
    commandHandler(EditComment),
    commandHandler(RemoveComment),
  ],
  exports: [CommentsService],
  contributes: {
    liveResources: [CommentLive],
    erasureContributors: [CommentsErasure],
    exportContributors: [CommentsExport],
    toolContributions: [commentsTools],
  },
});
