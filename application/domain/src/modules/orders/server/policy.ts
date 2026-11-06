import {
  type AuthorizeResult,
  defineCapability,
  exceeds,
  type Money,
  moneyAmount,
  type Principal,
} from '@hykr/contracts';
import { allow, needsApproval } from '@hykr/core';
import { can } from '@hykr/policy';

/**
 * What the orders module asks before a save runs. Levels, as this sample means them:
 *   2: the assistant writes an order for someone: that person confirms it.
 *   3: an order above the business's limit, made by someone who may not approve orders, or by
 *      the assistant: an owner decides, in the app, signed in.
 * The limit is the business's `money.amounts['orders.approval']`; until it sets one, the
 * module's default below. A limit in another currency than the order's counts as exceeded.
 */
export const APPROVAL_LIMIT_KEY = 'orders.approval';
export const DEFAULT_APPROVAL_LIMIT: Money = { minor: 50_000_000, currency: 'INR' };

/** Who may save an order above the limit without asking anyone. */
export const OrdersApprove = defineCapability({
  name: 'orders.approve',
  label: {
    en: 'Save large orders without approval',
    hi: 'बड़े ऑर्डर बिना मंज़ूरी के सहेजें',
    te: 'పెద్ద ఆర్డర్లను ఆమోదం లేకుండా సేవ్ చేయండి',
  },
  roles: ['owner', 'admin'],
});

/** The decision for a save of an order with this total. */
export function saveDecision(
  p: Principal,
  total: Money,
  money: { amounts: Readonly<Record<string, Money>> },
): AuthorizeResult {
  const limit = moneyAmount(money, APPROVAL_LIMIT_KEY) ?? DEFAULT_APPROVAL_LIMIT;
  const agent = p.actor.kind === 'agent';
  if (exceeds(total, limit) && (agent || !can(p, OrdersApprove.name)))
    return needsApproval('order_over_limit', 'An order this large needs an owner to approve it', {
      tier: 3,
      amount: total.minor,
      approver: { roles: ['owner'], channels: ['app'], minAssurance: 'session' },
    });
  if (agent)
    return needsApproval('agent_saves_order', 'Saving an order for you needs your approval', {
      tier: 2,
      amount: total.minor,
    });
  return allow('person_saves_order');
}
