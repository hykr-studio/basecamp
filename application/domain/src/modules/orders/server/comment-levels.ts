import { atLevel, defineLevelRule } from '@hykr/core';
import { Levels } from '../../../server/approval-levels.js';

/**
 * A comment on an order that a customer could read reaches someone outside the business: the
 * application's `external` level (the assistant's waits for the person it is for). A team-only
 * note stays inside, at no level.
 */
export const OrderCommentLevels = defineLevelRule({
  name: 'orders.comments',
  on: ['comment.add'],
  decide: ({ input }) =>
    input?.entity === 'order' && input.internal !== true
      ? atLevel(Levels.external.name, 'order_comment_goes_outside', 'A customer may read it')
      : null,
});
