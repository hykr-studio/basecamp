// Credits and caps (A3) as an application meets them: a notification that turns the framework's
// `credits.threshold` event into an email to the people who manage the credits, a purchase
// provider (small amounts settle at once, larger ones open a checkout the test settles), and a
// write hook that parks a large purchase. The deployment's prices come from CREDITS_CONFIG,
// which the credits e2e test sets. Only the credits e2e test boots `creditsApp`.
import {
  type CreditPurchaseProvider,
  defineModule,
  defineServer,
  type PurchaseStart,
} from '@hykr/api';
import {
  type Contributions,
  type CreditPurchaseInput,
  type CreditsThresholdRow,
  moduleSpec,
} from '@hykr/contracts';
import { needsApproval, type WriteHook } from '@hykr/core';
import { defineNotification } from '@hykr/notifications';
import { fixture } from '../../index.js';

/** A purchase of at least this much opens a checkout; less is paid at once. */
export const CHECKOUT_FROM = 10_000;
/** A purchase of at least this much waits for an approval. */
export const APPROVAL_FROM = 50_000;

/** What the provider was asked to start: the tests read it. */
export const started: PurchaseStart[] = [];

export const FixturePay: CreditPurchaseProvider = {
  name: 'fixture-pay',
  start: async (a) => {
    started.push(a);
    if (a.purchase.amount < CHECKOUT_FROM)
      return { ref: `instant-${a.purchase.id}`, status: 'paid' };
    return { ref: `fx-${a.purchase.id}`, checkoutUrl: `https://pay.example.test/${a.purchase.id}` };
  },
};

/** A large purchase needs an approval first. */
export const ParkLargePurchase: WriteHook = {
  name: 'fixture.credits.park',
  decide: ({ op, input }) =>
    op.name === 'credits.purchase' && (input as CreditPurchaseInput).amount >= APPROVAL_FROM
      ? needsApproval('fixture_large_purchase', 'A large purchase needs an approval')
      : null,
};

const words = (row: CreditsThresholdRow) =>
  row.level === 'pause'
    ? `The ${row.cap} cap is reached (${row.usedPercent}%): what it covers is paused.`
    : `The ${row.cap} cap is at ${row.usedPercent}% (alert at ${row.threshold}%).`;

/** The alert, by email, to whoever manages the business's credits. */
export const CreditsAlert = defineNotification<CreditsThresholdRow>({
  key: 'credit_checks.alert',
  topic: 'service',
  send: { on: ['credits.threshold'] },
  to: (row) => row.recipients.map((userId) => ({ userId })),
  channels: ['email'],
  email: {
    subject: (row) => `[credits] ${row.cap} ${row.level}`,
    body: (row) => words(row),
  },
  dedupe: (row) => `credits.alert:${row.id}`,
});

export const creditsContributions: Partial<Contributions> = {
  creditPurchaseProviders: [FixturePay],
  writeHooks: [ParkLargePurchase],
};

/** The notification lives in a module of its own, after the fixture's. */
export const creditsModule = defineModule({
  ...moduleSpec({ name: 'credit_checks', dependsOn: ['tasks'], entities: {}, commands: [] }),
  notifications: [CreditsAlert],
});

/** The fixture, with everything above. */
export const creditsApp = defineServer({
  ...fixture.definition,
  modules: [...fixture.definition.modules, creditsModule],
  contributes: creditsContributions,
});
