import { type PageSpec, SavedPageSpec } from '@app/contracts';
import { defineEntity, deny } from '@app/core';
import { pages } from '@app/db';
import { registry } from '@app/ui-registry';

/** Saved canvas pages. The spec must name registered views with valid queries. */
export const Page = defineEntity(SavedPageSpec, {
  table: pages,
  owner: (t) => t.ownerId,
  rules: [
    (_p, _action, _row, input) => {
      const spec = input?.spec as PageSpec | undefined;
      const errors = spec ? registry.checkPage(spec) : [];
      return errors.length
        ? deny('bad_spec', `Page layout is invalid: ${errors.join('; ')}`)
        : null;
    },
  ],
});
