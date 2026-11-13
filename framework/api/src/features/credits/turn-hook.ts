// The assistant's turns under credits: refused before the model runs when the business is
// paused (tokens or tool calls capped), and metered after (tokens, priced by the model, and one
// tool call per tool it called).
import { CreditsViewCapability, type Subject } from '@hykr/contracts';
import { schema } from '@hykr/db';
import { type Labels, languages, type MessageKey, pick, t } from '@hykr/i18n';
import { can, subjectKeyOf } from '@hykr/policy';
import { Logger } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import type { TurnGate, TurnHook, TurnInfo, TurnOutcome } from '../../hooks.js';
import { TURN_METERS } from './budget.js';
import { type CreditsService, creditsService } from './credits.service.js';
import { FrameworkMeters } from './meters.js';

const log = new Logger('Credits');

/** A framework phrase in each of the application's languages. */
const labels = (key: MessageKey, vars: Record<string, string> = {}): Labels =>
  Object.fromEntries(languages().codes.map((lang) => [lang, t(lang, key, vars)])) as Labels;

/** This person's WhatsApp contact in the business: the number they wrote from. */
async function contactOf(svc: CreditsService, tenantId: string, subject: Subject) {
  const { contacts } = schema;
  const [contact] = await svc.database
    .select({ id: contacts.id, tenantId: contacts.tenantId, userId: contacts.userId })
    .from(contacts)
    .where(
      and(
        eq(contacts.tenantId, tenantId),
        subject.kind === 'contact'
          ? eq(contacts.id, subject.contactId)
          : eq(contacts.userId, subject.userId),
      ),
    )
    .limit(1);
  return contact;
}

/**
 * A paused turn: a member hears that the assistant is paused and credits can be added; a
 * customer on WhatsApp is handed to the team (the conversation shows in the back office) and
 * told someone will reply.
 */
async function before(svc: CreditsService, turn: TurnInfo): Promise<TurnGate | null> {
  const p = turn.principal;
  if (!p.tenantId) return null;
  // What a turn spends, as `turnRefusal` (the credits status) reads it.
  const refusals = await svc.checkMany(
    p.tenantId,
    TURN_METERS.map((m) => ({ meter: m.name })),
  );
  const refusal = refusals.find((r) => r !== null) ?? null;
  // Settings that do not parse: the model policy refuses the turn itself (503), naming why.
  if (!refusal || refusal.rule === 'credits_unavailable') return null;
  let say = labels('credits.paused');
  if (!can(p, CreditsViewCapability) && turn.channel === 'whatsapp' && p.subject) {
    const contact = await contactOf(svc, p.tenantId, p.subject);
    if (contact) {
      const { settings } = await svc.tenantInfo(p.tenantId);
      say = labels('channel.handoff', { replyTime: settings.replyTime });
      const lang = turn.lang ?? 'en';
      await svc.handOver(contact, { message: turn.message, reply: pick(say, lang), lang });
    }
  }
  return { refuse: { rule: refusal.rule, reason: refusal.reason, status: 402, say } };
}

/** What the turn used: its tokens (if the model reported them) and its tool calls. */
async function after(svc: CreditsService, turn: TurnInfo, outcome: TurnOutcome) {
  const p = turn.principal;
  if (!p.tenantId) return;
  const common = {
    tenantId: p.tenantId,
    subject: subjectKeyOf(p),
    runId: turn.runId,
    channel: turn.channel,
    source: 'turn',
  };
  const usage = outcome.usage;
  const tokens =
    (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0) || (usage?.totalTokens ?? 0);
  await svc.record([
    ...(usage && tokens > 0
      ? [
          {
            ...common,
            meter: FrameworkMeters.tokens.name,
            quantity: tokens,
            variant: turn.model ?? null,
            // Priced by the model: its input and output, as the service prices every model call.
            tokens: { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens },
          },
        ]
      : []),
    ...(outcome.toolCalls.length
      ? [{ ...common, meter: FrameworkMeters.toolCalls.name, quantity: outcome.toolCalls.length }]
      : []),
  ]);
}

/**
 * The credits turn hook, contributed by the feature. It reaches the running CreditsService
 * through its slot: before the feature starts (Studio, the evals), it has no opinion.
 */
export const CreditsTurnHook: TurnHook = {
  name: 'credits',
  before: async (turn) => {
    const svc = creditsService();
    return svc ? before(svc, turn) : null;
  },
  after: async (turn, outcome) => {
    const svc = creditsService();
    if (!svc) return;
    await after(svc, turn, outcome).catch((e) =>
      log.error(`run=${turn.runId} metering failed: ${e instanceof Error ? e.message : e}`),
    );
  },
};
