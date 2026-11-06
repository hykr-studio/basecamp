import type { AuthorizeResult, WriteAction } from '@hykr/contracts';
import { and, type Column, getTableColumns, type SQL, sql } from 'drizzle-orm';
import { deny, RuleDenied } from '../authorize.js';
import { type ChildLink, childLinkOf } from '../entity/children.js';
import type { EntityPlugin } from '../hooks.js';

type Values = Record<string, unknown>;

/** A child write that only its parent's tree writes may make, or null. */
function refusal(
  link: ChildLink,
  action: WriteAction,
  row: Values | null,
  input: Values | null,
  crud: boolean,
): AuthorizeResult | null {
  const { trait, child } = link;
  if (action === 'create')
    return deny(
      'children_through_parent',
      `A ${child.label} is added through its ${link.parent.spec.label}, with the rest of it`,
    );
  // Deleting one node of a tree would take its subtree with it, unaudited: save the parent.
  if (action === 'delete' && crud && trait.nest)
    return deny(
      'tree_through_parent',
      `A ${child.label} is removed when its ${link.parent.spec.label} is saved without it`,
    );
  if (action !== 'update' || !row || !input) return null;
  const moved = (key: string | undefined) =>
    key !== undefined && input[key] !== undefined && input[key] !== row[key];
  if (moved(trait.field))
    return deny('parent_fixed', `A ${child.label} stays with its ${link.parent.spec.label}`);
  if (crud && (moved(trait.nest) || moved(trait.position)))
    return deny(
      'tree_through_parent',
      `A ${child.label} moves only when its ${link.parent.spec.label} is saved`,
    );
  return null;
}

/**
 * Records with a parent (`traits.parent`, served by `defineChildEntity`). Every read and write
 * of a child also needs its parent to exist in the same business with the same owner and
 * customer, and to pass the parent's own plugins' scopes, so a child is reached exactly when
 * its parent is (a chain of parents is checked to the top). A child is never created one by
 * one, never moves to another parent, and its place in the tree changes only through a command.
 */
export const parentPlugin: EntityPlugin = {
  name: 'parent',
  appliesTo: (spec) => spec.traits?.parent !== undefined,
  scope: (p, op, { spec }) => {
    const link = childLinkOf(spec.name);
    // A trait without defineChildEntity: nothing is known about the parent, so nothing is reached.
    if (!link) return sql`false`;
    const parent = link.parent;
    const pc = getTableColumns(parent.table) as Record<string, Column>;
    const target = { spec: parent.spec, table: parent.table };
    const parentScopes = parent
      .plugins()
      .map((x) => x.scope?.(p, op, target))
      .filter((x): x is SQL => x !== undefined);
    const customer =
      link.customer && link.parentCustomer
        ? sql` and ${link.parentCustomer} is not distinct from ${link.customer}`
        : sql``;
    const more = parentScopes.length ? sql` and ${and(...parentScopes)}` : sql``;
    return sql`exists (select 1 from ${parent.table} where ${pc.id} = ${link.fk} and ${pc.tenantId} = ${link.tenant} and ${link.parentOwner} = ${link.owner}${customer}${more})`;
  },
  decide: (_p, action, row, input, { spec }) => {
    const link = childLinkOf(spec.name);
    if (!link) return deny('no_parent', `${spec.label} has no parent defined`);
    return refusal(link, action, row, input, true);
  },
  toValues: (values, { action, row, input }, { spec }) => {
    const link = childLinkOf(spec.name);
    if (!link) throw new RuleDenied(deny('no_parent', `${spec.label} has no parent defined`));
    const r = refusal(link, action, row, input, false);
    if (r) throw new RuleDenied(r);
    return values;
  },
};
