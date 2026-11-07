// Credits and caps (A3) as an application meets them: a notification that turns the framework's
// `credits.threshold` event into an email to the people who manage the credits, a purchase
// provider (small amounts settle at once, larger ones open a checkout the test settles), and a
// write hook that parks a large purchase. The deployment's prices come from CREDITS_CONFIG,
// which the credits e2e test sets. Only the credits e2e test boots `creditsApp`.
//
// H3 adds a second provider whose payments are confirmed the way a real gateway's are: by a
// signed webhook on a B10 connection, whose handler settles the purchase for that connection's
// business. And a module's own metered work: a report rendered page by page (the
// `report_pages` meter), with a script that renders, then adds a task, so a run can cross the
// cap in its first call.

import { call, defineScript, say, written } from '@hykr/agents/script';
import {
  type CreditPurchaseProvider,
  CreditsService,
  defineConnectorHandler,
  defineMeter,
  defineModule,
  defineServer,
  metering,
  type PurchaseStart,
} from '@hykr/api';
import { hmacConnector } from '@hykr/connectors';
import {
  type Contributions,
  type CreditPurchaseInput,
  type CreditsThresholdRow,
  commandSpec,
  moduleSpec,
} from '@hykr/contracts';
import {
  allow,
  commandController,
  commandHandler,
  defineCommand,
  needsApproval,
  type WriteHook,
} from '@hykr/core';
import { defineNotification } from '@hykr/notifications';
import { subjectKeyOf } from '@hykr/policy';
import { Module } from '@nestjs/common';
import { z } from 'zod';
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

/* ── A gateway that confirms by webhook (B10) ────────────────────────────── */

/** The gateway's name: its purchase provider and its connector. */
export const GATEWAY = 'fixture-gateway';

/** It always opens a checkout; the person pays there, and the gateway tells us by webhook. */
export const FixtureGateway: CreditPurchaseProvider = {
  name: GATEWAY,
  start: async (a) => ({
    ref: `gw-${a.purchase.id}`,
    checkoutUrl: `https://gateway.example.test/pay/${a.purchase.id}`,
  }),
};

/**
 * The gateway signs the raw body (`x-gateway-signature: sha256=<hex>`) and names each event
 * (`x-gateway-event`); the body is `{ type: 'payment.succeeded' | 'payment.failed', purchaseId,
 * ref }`, with our purchase id as the gateway was given it.
 */
export const gatewayConnector = hmacConnector({
  name: GATEWAY,
  label: { en: 'Fixture gateway', hi: 'फ़िक्स्चर गेटवे', te: 'ఫిక్స్చర్ గేట్‌వే' },
  header: 'x-gateway-signature',
  prefix: 'sha256=',
  idHeader: 'x-gateway-event',
});

const Payment = z.object({ purchaseId: z.string().min(1), ref: z.string().max(200).optional() });

/** A verified payment event settles the purchase, for the connection's own business only. */
export const settleFromGateway = defineConnectorHandler({
  name: 'credit-checks.settle',
  connector: GATEWAY,
  on: ['payment.succeeded', 'payment.failed'],
  handle: async (event, ctx) => {
    const { purchaseId, ref } = Payment.parse(event.data);
    await ctx.get(CreditsService).settlePurchase(
      { tenantId: event.tenantId, provider: GATEWAY, purchaseId },
      {
        status: event.type === 'payment.succeeded' ? 'paid' : 'failed',
        ...(ref ? { ref } : {}),
      },
    );
  },
});

/* ── A module's own metered work ─────────────────────────────────────────── */

/** Report pages rendered: priced per page by the test's CREDITS_CONFIG or a business's plan. */
export const ReportPages = defineMeter({ name: 'report_pages', unit: 'page' });

export const RenderReportSpec = commandSpec({
  name: 'credit_checks.render',
  description: 'Render a report of the business, page by page (each page costs credits).',
  input: z.object({ pages: z.number().int().min(1).max(100) }),
  output: z.object({ pages: z.number() }),
  http: { method: 'POST', path: '/api/credit-checks/render' },
  tool: 'render-report',
  expose: 'all',
});

/** Renders nothing, but meters the pages for the business, as a real render would. */
export const RenderReport = defineCommand(RenderReportSpec, {
  resource: { type: 'report', id: () => null },
  authorize: () => allow('fixture_render'),
  summarize: (input) => `Render ${input.pages} report pages`,
  run: async ({ principal, input }) => {
    await metering()?.record({
      tenantId: principal.tenantId as string,
      meter: ReportPages.name,
      quantity: input.pages,
      subject: subjectKeyOf(principal),
      runId: principal.runId ?? null,
      channel: principal.channel ?? null,
      source: 'credit_checks.render',
    });
    return { value: { pages: input.pages }, touched: [] };
  },
});

@Module({
  controllers: [commandController(RenderReport)],
  providers: [commandHandler(RenderReport)],
})
export class CreditChecksModule {}

/**
 *   render <n> report pages then add <title>   render-report, then create-task, then "Done."
 */
const scripts = [
  defineScript({
    name: 'credit-checks-render',
    match: (text) => {
      const m = /^render (\d+) report pages? then add (.+)$/i.exec(text.split('\n')[0]?.trim());
      return m ? { pages: Number(m[1]), title: m[2] } : undefined;
    },
    step: ({ pages, title }: { pages: number; title: string }, turn) => {
      if (!turn.result('render-report')) return [call('render-report', { pages })];
      const made = turn.result('create-task');
      if (!made) return [call('create-task', { title })];
      return [say(written(made, (task) => `Rendered ${pages} pages and added ${task.title}.`))];
    },
  }),
];

/* ── The rest ────────────────────────────────────────────────────────────── */

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
  creditPurchaseProviders: [FixturePay, FixtureGateway],
  writeHooks: [ParkLargePurchase],
  meters: [ReportPages],
  connectors: [gatewayConnector],
  connectorHandlers: [settleFromGateway],
};

/** The notification and the metered render live in a module of their own, after the fixture's. */
export const creditsModule = defineModule({
  ...moduleSpec({
    name: 'credit_checks',
    dependsOn: ['tasks'],
    entities: {},
    commands: [RenderReportSpec],
  }),
  server: CreditChecksModule,
  notifications: [CreditsAlert],
  agent: { scripts },
});

/** The fixture, with everything above. */
export const creditsApp = defineServer({
  ...fixture.definition,
  modules: [...fixture.definition.modules, creditsModule],
  contributes: creditsContributions,
});
