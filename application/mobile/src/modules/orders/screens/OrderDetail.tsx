import type { OrderItemView } from '@application/domain/modules/orders/contracts';
import { CancelOrderSpec } from '@application/domain/modules/orders/contracts';
import {
  Button,
  DecisionScrollView,
  errorMessage,
  History,
  Loading,
  SectionHeading,
  space,
  styles,
  useCommand,
  useEntity,
  useEntityList,
  useMoneyText,
  useScreenContext,
} from '@hykr/app';
import { buildTree, type TreeNode } from '@hykr/contracts';
import { Text, View } from 'react-native';

function Node({ node, depth }: { node: TreeNode<OrderItemView>; depth: number }) {
  const money = useMoneyText();
  const group = node.kind === 'group';
  return (
    <View style={{ gap: space.xs, paddingLeft: depth * space.md }}>
      <View style={[styles.row, { justifyContent: 'space-between' }]}>
        <Text style={group ? styles.heading : styles.text}>{node.title}</Text>
        <Text style={group ? styles.heading : styles.text}>{money(node.amount)}</Text>
      </View>
      {!group && node.unitPrice && (
        <Text style={styles.muted}>
          {node.quantity} × {money(node.unitPrice)}
          {node.taxRateBp ? ` · tax ${node.taxRateBp / 100}%` : ''}
          {node.cost ? ` · cost ${money(node.cost)}` : ''}
        </Text>
      )}
      {node.children.map((c) => (
        <Node key={c.id} node={c} depth={depth + 1} />
      ))}
    </View>
  );
}

/**
 * One order: its groups and lines as a tree, its tax lines and totals, and its history. The
 * orders/[id] route shows it, and so does the canvas (order.detail).
 */
export function OrderDetail({ id, embedded = false }: { id: string; embedded?: boolean }) {
  useScreenContext(embedded ? undefined : { screen: 'order', record: { type: 'order', id } });
  const order = useEntity('orders', id);
  const items = useEntityList('orderItems', { orderId: id, limit: 1000 });
  const cancel = useCommand(CancelOrderSpec);
  const money = useMoneyText();
  if (!order.data) return <Loading error={order.error} />;
  const o = order.data;
  const tree = buildTree(items.items as OrderItemView[], {
    key: 'id',
    parent: 'parentItemId',
    order: 'position',
  });
  return (
    <DecisionScrollView contentContainerStyle={styles.content}>
      <View style={{ gap: space.sm }}>
        <Text style={styles.title} accessibilityRole="header">
          {o.title}
        </Text>
        <Text style={styles.muted}>
          {o.number}
          {o.status === 'cancelled' ? ' · cancelled' : ''}
        </Text>
      </View>
      <SectionHeading>Items</SectionHeading>
      {tree.map((n) => (
        <Node key={n.id} node={n} depth={0} />
      ))}
      <View style={[styles.card, { gap: space.xs }]}>
        <View style={[styles.row, { justifyContent: 'space-between' }]}>
          <Text style={styles.text}>Subtotal</Text>
          <Text style={styles.text}>{money(o.subtotal)}</Text>
        </View>
        {o.taxLines.map((t) => (
          <View key={t.code} style={[styles.row, { justifyContent: 'space-between' }]}>
            <Text style={styles.muted}>{t.label ?? t.code}</Text>
            <Text style={styles.muted}>{money(t.amount)}</Text>
          </View>
        ))}
        <View style={[styles.row, { justifyContent: 'space-between' }]}>
          <Text style={styles.heading}>Total</Text>
          <Text style={styles.heading}>{money(o.total)}</Text>
        </View>
      </View>
      {o.status === 'open' && (
        <Button
          title="Cancel order"
          variant="secondary"
          busy={cancel.isPending}
          onPress={() => cancel.mutate({ orderId: o.id })}
        />
      )}
      {cancel.error && <Text style={styles.error}>{errorMessage(cancel.error)}</Text>}
      <History type="order" id={o.id} />
    </DecisionScrollView>
  );
}
