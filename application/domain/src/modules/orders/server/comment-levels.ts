import { commentWriteOf } from '@hykr/contracts';
import { atLevel, defineLevelRule } from '@hykr/core';
import { Levels } from '../../../server/approval-levels.js';

/**
 * A comment on an order that a customer could read reaches someone outside the business: the
 * application's `external` level (the assistant's waits for the person it is for). An edit
 * publishes new text to the same readers, so it is at the same level. A team-only note stays
 * inside, at no level.
 */
export const OrderCommentLevels = defineLevelRule({
  name: 'orders.comments',
  on: ['comment.add', 'comment.edit'],
  decide: (a) => {
    const comment = commentWriteOf(a);
    return comment?.on.entity === 'order' && !comment.internal
      ? atLevel(Levels.external.name, 'order_comment_goes_outside', 'A customer may read it')
      : null;
  },
});
