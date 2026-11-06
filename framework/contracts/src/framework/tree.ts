/**
 * Records with a parent: a child entity's rows belong to one parent record (an order's items),
 * and may nest among themselves (group → line) to any depth. The trait names the fields; the
 * `parent` plugin (@hykr/core) scopes a child through its parent, and `defineChildEntity`
 * writes whole trees at once.
 */
export interface ParentTrait {
  /** The parent entity's name: 'order'. */
  entity: string;
  /** This entity's field holding the parent's id: 'orderId'. */
  field: string;
  /** This entity's field pointing at another node of the same parent, for a tree. */
  nest?: string;
  /** This entity's field ordering siblings (0, 1, 2…), set by the framework. */
  position?: string;
  /** How deep a tree may go. Default 8. */
  maxDepth?: number;
  /** How many nodes one parent may hold. Default 1000. */
  maxNodes?: number;
}

declare module './traits.js' {
  interface EntityTraits {
    parent?: ParentTrait;
  }
}

export const TREE_MAX_DEPTH = 8;
export const TREE_MAX_NODES = 1000;

/** A node and the nodes under it. */
export type TreeNode<T> = T & { children: TreeNode<T>[] };

/** A tree's shape is wrong: an unknown parent, a repeated key, a cycle, too deep or too big. */
export class TreeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TreeError';
  }
}

/**
 * Rows (or flat input) as a tree: `key` names each row's own key ('id', or a client's 'ref'),
 * `parent` the key of the row it sits under (empty: at the top), and `order` the field siblings
 * sort by (otherwise the input's order). A parent that is not there, a key given twice and a
 * cycle throw a TreeError.
 */
export function buildTree<T extends object>(
  rows: readonly T[],
  opts: { key: string; parent: string; order?: string },
): TreeNode<T>[] {
  const field = (row: T, name: string) => (row as Record<string, unknown>)[name];
  const nodes = new Map<unknown, TreeNode<T>>();
  for (const row of rows) {
    const key = field(row, opts.key);
    if (key === undefined || key === null || key === '')
      throw new TreeError(`A node has no ${opts.key}`);
    if (nodes.has(key)) throw new TreeError(`The ${opts.key} "${String(key)}" is given twice`);
    nodes.set(key, { ...row, children: [] });
  }
  const roots: TreeNode<T>[] = [];
  for (const node of nodes.values()) {
    const up = field(node, opts.parent);
    if (up === undefined || up === null || up === '') {
      roots.push(node);
      continue;
    }
    const parent = nodes.get(up);
    if (!parent)
      throw new TreeError(
        `No node "${String(up)}" to put "${String(field(node, opts.key))}" under`,
      );
    parent.children.push(node);
  }
  if (countNodes(roots) !== nodes.size) throw new TreeError('The nodes form a cycle');
  const order = opts.order;
  if (order) {
    const sort = (list: TreeNode<T>[]) => {
      list.sort((a, b) => Number(field(a, order) ?? 0) - Number(field(b, order) ?? 0));
      for (const n of list) sort(n.children);
    };
    sort(roots);
  }
  return roots;
}

/** How many nodes a forest holds. */
export function countNodes(nodes: readonly { children?: readonly unknown[] }[]): number {
  let n = 0;
  const walk = (list: readonly { children?: readonly unknown[] }[]) => {
    for (const x of list) {
      n += 1;
      walk((x.children ?? []) as { children?: readonly unknown[] }[]);
    }
  };
  walk(nodes);
  return n;
}

/** How many levels deep a forest goes (0 for none). */
export function treeDepth(nodes: readonly { children?: readonly unknown[] }[]): number {
  let max = 0;
  for (const x of nodes)
    max = Math.max(max, 1 + treeDepth((x.children ?? []) as { children?: readonly unknown[] }[]));
  return max;
}

/** Each node top-down (a parent before its children), with its depth and the node above it. */
export function flattenTree<T extends { children?: readonly T[] }>(
  nodes: readonly T[],
): { node: T; depth: number; parent: T | null; index: number }[] {
  const out: { node: T; depth: number; parent: T | null; index: number }[] = [];
  const walk = (list: readonly T[], depth: number, parent: T | null) => {
    list.forEach((node, index) => {
      out.push({ node, depth, parent, index });
      walk(node.children ?? [], depth + 1, node);
    });
  };
  walk(nodes, 1, null);
  return out;
}
