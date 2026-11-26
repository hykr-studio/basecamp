// The orders views' words for an order's state: an accepted order says so in each language, from
// the module's own states (ORDER_STATES), on WhatsApp's text and in the list.
import { describe, expect, it } from 'vitest';
import type { OrderView } from '../contracts/index.js';
import { OrderCardView, OrderListView } from './order.js';

const money = (minor: number) => ({ minor, currency: 'INR' });

const order = (status: OrderView['status'], extra: Partial<OrderView> = {}): OrderView => ({
  id: crypto.randomUUID(),
  number: 'ORD/2026-27/0007',
  title: 'Flat 9C',
  status,
  cancelReason: null,
  version: 4,
  seriesId: null,
  revision: 1,
  currency: 'INR',
  subtotal: money(300_000),
  taxTotal: money(54_000),
  total: money(354_000),
  taxLines: [],
  lineCount: 1,
  createdBy: 'person',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  ...extra,
});

const ctx = (lang: 'en' | 'hi' | 'te') => ({ timeZone: 'Asia/Kolkata', lang });

describe('an accepted order in the views', () => {
  it('the card says it is accepted, in each language', () => {
    const o = order('accepted');
    expect(OrderCardView.text({ id: o.id, item: o }, ctx('en')).split('\n')[0]).toBe(
      'ORD/2026-27/0007 · Flat 9C (accepted)',
    );
    expect(OrderCardView.text({ id: o.id, item: o }, ctx('hi')).split('\n')[0]).toBe(
      'ORD/2026-27/0007 · Flat 9C (स्वीकृत)',
    );
    expect(OrderCardView.text({ id: o.id, item: o }, ctx('te')).split('\n')[0]).toBe(
      'ORD/2026-27/0007 · Flat 9C (అంగీకరించబడింది)',
    );
  });

  it('the list tells an accepted order from an approved one, and a revision says which', () => {
    const text = OrderListView.text(
      { items: [order('approved'), order('accepted', { revision: 2 })] },
      ctx('en'),
    );
    expect(text).toContain('Flat 9C: ₹3,540.00 (approved)');
    expect(text).toContain('Flat 9C: ₹3,540.00 (v2, accepted)');
  });
});
