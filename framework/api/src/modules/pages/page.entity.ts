import { type PageSpec, SavedPageSpec } from '@hykr/contracts';
import { defineEntity, deny } from '@hykr/core';
import { pages } from '@hykr/db';
import { runtime } from '../../runtime.js';

/** Saved canvas pages. The spec must name registered views with valid queries. */
export const Page = defineEntity(SavedPageSpec, {
  table: pages,
  owner: (t) => t.ownerId,
  rules: [
    (_p, _action, _row, input) => {
      const spec = input?.spec as PageSpec | undefined;
      const errors = spec ? runtime().registry.checkPage(spec) : [];
      return errors.length
        ? deny('bad_spec', `Page layout is invalid: ${errors.join('; ')}`)
        : null;
    },
  ],
});
