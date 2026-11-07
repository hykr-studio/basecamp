import {
  type OrderItemView,
  OrderSpec,
  ReviseOrderSpec,
} from '@application/domain/modules/orders/contracts';
import {
  Button,
  Comments,
  DecisionScrollView,
  errorMessage,
  History,
  Loading,
  RecordAcceptance,
  RecordDocuments,
  SectionHeading,
  ShareLinks,
  SlaBadge,
  StateBadge,
  space,
  styles,
  TransitionBar,
  useCommand,
  useEntity,
  useEntityList,
  useMoneyText,
  useScreenContext,
  useVersions,
  VersionList,
} from '@hykr/app';
import { buildTree, diffLists, type TreeNode } from '@hykr/contracts';
import { router } from 'expo-router';
import { Text, View } from 'react-native';

/** A line's place in the order, for comparing revisions: "Kitchen / Sink". */
const pathOf = (items: readonly OrderItemView[]) => {
  const byId = new Map(items.map((i) => [i.id, i]));
  return (item: OrderItemView) => {
    const parts = [item.title];
    for (let at = item.parentItemId; at; at = byId.get(at)?.parentItemId ?? null)
      parts.unshift(byId.get(at)?.title ?? '');
    return parts.join(' / ');
  };
};

/** What changed in this revision against the one before it: lines added, removed, changed. */
function Changes({ id, before }: { id: string; before: string }) {
  const money = useMoneyText();
  const now = useEntityList('orderItems', { orderId: id, limit: 1000 });
  const then = useEntityList('orderItems', { orderId: before, limit: 1000 });
  if (now.loading || then.loading) return null;
  const a = then.items as OrderItemView[];
  const b = now.items as OrderItemView[];
  const d = diffLists(a, b, (i) => (b.includes(i) ? pathOf(b)(i) : pathOf(a)(i)), {
    ignore: ['position', 'parentItemId', 'orderId'],
  });
  if (!d.added.length && !d.removed.length && !d.changed.length)
    return <Text style={styles.muted}>No changes to the items since the last revision.</Text>;
  return (
    <View style={{ gap: space.xs }}>
      {d.added.map((i) => (
        <Text key={`+${i.id}`} style={styles.text}>{`+ ${i.title} · ${money(i.amount)}`}</Text>
      ))}
      {d.removed.map((i) => (
        <Text key={`-${i.id}`} style={styles.muted}>{`− ${i.title} · ${money(i.amount)}`}</Text>
      ))}
      {d.changed.map((c) => (
        <Text key={`~${c.after.id}`} style={styles.text}>
          {`~ ${c.after.title}: ${money(c.before.amount)} → ${money(c.after.amount)}`}
        </Text>
      ))}
    </View>
  );
}

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
 * One order: its state and moves, its groups and lines as a tree, its tax lines and totals, its
 * revisions, its PDFs (make, open, send to me), its customer's acceptance, its discussion
 * (comments with @-mentions) and its history. The orders/[id] route shows it, and so does the
 * canvas (order.detail).
 */
export function OrderDetail({ id, embedded = false }: { id: string; embedded?: boolean }) {
  useScreenContext(embedded ? undefined : { screen: 'order', record: { type: 'order', id } });
  const order = useEntity('orders', id);
  const items = useEntityList('orderItems', { orderId: id, limit: 1000 });
  const versions = useVersions('order', id);
  const revise = useCommand(ReviseOrderSpec);
  const money = useMoneyText();
  if (!order.data) return <Loading error={order.error} />;
  const o = order.data;
  const tree = buildTree(items.items as OrderItemView[], {
    key: 'id',
    parent: 'parentItemId',
    order: 'position',
  });
  const list = versions.data ?? [];
  const previous = list[list.findIndex((v) => v.current) - 1];
  return (
    <DecisionScrollView contentContainerStyle={styles.content}>
      <View style={{ gap: space.sm }}>
        <Text style={styles.title} accessibilityRole="header">
          {o.title}
        </Text>
        <Text style={styles.muted}>{o.number}</Text>
        <StateBadge spec={OrderSpec} row={o} />
        {o.cancelReason ? <Text style={styles.muted}>{o.cancelReason}</Text> : null}
        <SlaBadge plural="orders" id={o.id} />
      </View>
      <TransitionBar spec={OrderSpec} row={o} />
      {o.status === 'submitted' || o.status === 'expired' ? (
        <Button
          title="Revise"
          variant="secondary"
          busy={revise.isPending}
          onPress={() =>
            revise.mutate(
              { orderId: o.id },
              {
                onSuccess: (r) => {
                  if (r.status === 'done') router.navigate(`/orders/${r.value.order.id}`);
                },
              },
            )
          }
        />
      ) : null}
      {revise.error && <Text style={styles.error}>{errorMessage(revise.error)}</Text>}
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
      {list.length > 1 ? (
        <View style={{ gap: space.sm }}>
          <SectionHeading>Revisions</SectionHeading>
          <VersionList spec={OrderSpec} id={o.id} />
          {previous ? <Changes id={o.id} before={previous.id} /> : null}
        </View>
      ) : null}
      <RecordDocuments entity="order" id={o.id} />
      {/* Its customer accepts the newest PDF by a one-time code (OrderAcceptance). */}
      <RecordAcceptance entity="order" id={o.id} />
      {/* A link for its customer: the order, its lines and PDF, accepted with a code on WhatsApp. */}
      <ShareLinks target={{ entity: 'order', id: o.id }} to={{ recordCustomer: true }} />
      <Comments entity="order" id={o.id} />
      <History type="order" id={o.id} />
    </DecisionScrollView>
  );
}
