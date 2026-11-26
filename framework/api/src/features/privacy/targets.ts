// The framework's own data that can expire (B18), as retention targets with no period: the
// application gives each one a period (`retentionPeriods`), and a business may change the period
// of a business's target in its `privacy` settings. Without a period, a target never runs.
import { PRIVACY_REQUEST } from '@hykr/contracts';
import {
  domainEvents,
  inboundEvents,
  outbox,
  privacyRequests,
  threadMessages,
  threads,
} from '@hykr/db';
import { and, eq, inArray, isNotNull, lt, not, or, sql } from 'drizzle-orm';
import { eraseFilesOn } from '../files/privacy.js';
import { expireTraces } from './mastra.js';
import type { RetentionTarget } from './registry.js';

const count = (rows: readonly unknown[]) => ({ count: rows.length });

/** Raw WhatsApp webhook payloads, kept for debugging and replay: emptied, the row kept. */
export const InboundPayloads: RetentionTarget = {
  name: 'channel.inbound-payloads',
  label: {
    en: 'Raw WhatsApp messages as received',
    hi: 'मिले हुए WhatsApp संदेशों का मूल रूप',
    te: 'అందిన WhatsApp సందేశాల మూల రూపం',
  },
  scope: 'deployment',
  action: 'empty',
  apply: async ({ before, tx }) =>
    count(
      await tx
        .update(inboundEvents)
        .set({ payload: null })
        .where(and(isNotNull(inboundEvents.payload), lt(inboundEvents.receivedAt, before)))
        .returning({ id: inboundEvents.id }),
    ),
};

/** What people and the assistant said in conversations (on every channel). */
export const ChatMessages: RetentionTarget = {
  name: 'chat.messages',
  label: { en: 'Conversation messages', hi: 'बातचीत के संदेश', te: 'సంభాషణ సందేశాలు' },
  scope: 'tenant',
  action: 'delete',
  apply: async ({ tenantId, before, tx }) => {
    if (!tenantId) return { count: 0 };
    const here = tx.select({ id: threads.id }).from(threads).where(eq(threads.tenantId, tenantId));
    return count(
      await tx
        .delete(threadMessages)
        .where(and(inArray(threadMessages.threadId, here), lt(threadMessages.createdAt, before)))
        .returning({ id: threadMessages.id }),
    );
  },
};

/**
 * Stored events already passed on, withdrawn by an undo, or failed (each holds a copy of its
 * record).
 */
export const RelayedEvents: RetentionTarget = {
  name: 'events.relayed',
  label: { en: 'Events passed on', hi: 'आगे भेजे गए इवेंट', te: 'పంపిన ఈవెంట్‌లు' },
  scope: 'tenant',
  action: 'delete',
  apply: async ({ tenantId, before, tx }) =>
    tenantId
      ? count(
          await tx
            .delete(domainEvents)
            .where(
              and(
                eq(domainEvents.tenantId, tenantId),
                or(
                  isNotNull(domainEvents.relayedAt),
                  isNotNull(domainEvents.cancelledAt),
                  isNotNull(domainEvents.failedAt),
                ),
                lt(domainEvents.occurredAt, before),
              ),
            )
            .returning({ id: domainEvents.id }),
        )
      : { count: 0 },
};

/** Notifications already sent on, or withdrawn by an undo (each holds a copy of its record). */
export const RelayedOutbox: RetentionTarget = {
  name: 'outbox.relayed',
  label: { en: 'Notifications sent', hi: 'भेजी गई सूचनाएँ', te: 'పంపిన నోటిఫికేషన్‌లు' },
  scope: 'tenant',
  action: 'delete',
  apply: async ({ tenantId, before, tx }) =>
    tenantId
      ? count(
          await tx
            .delete(outbox)
            .where(
              and(
                eq(outbox.tenantId, tenantId),
                or(isNotNull(outbox.relayedAt), isNotNull(outbox.cancelledAt)),
                lt(outbox.createdAt, before),
              ),
            )
            .returning({ id: outbox.id }),
        )
      : { count: 0 },
};

/** Export archives made for people's requests: erased (the request stays, without its file). */
export const ExportArchives: RetentionTarget = {
  name: 'privacy.archives',
  label: {
    en: 'Copies of personal data made for requests',
    hi: 'अनुरोधों के लिए बनी निजी डेटा की कॉपियाँ',
    te: 'అభ్యర్థనల కోసం చేసిన వ్యక్తిగత డేటా కాపీలు',
  },
  scope: 'tenant',
  action: 'delete',
  apply: async ({ tenantId, before, tx }) => {
    if (!tenantId) return { count: 0 };
    const old = await tx
      .update(privacyRequests)
      .set({ files: sql`'{}'::text[]` })
      .where(
        and(
          eq(privacyRequests.tenantId, tenantId),
          lt(privacyRequests.completedAt, before),
          not(eq(privacyRequests.files, sql`'{}'::text[]`)),
        ),
      )
      .returning({ id: privacyRequests.id });
    if (!old.length) return { count: 0 };
    await eraseFilesOn(tx, {
      tenantId,
      resourceType: PRIVACY_REQUEST,
      ids: old.map((r) => r.id),
    });
    return { count: old.length };
  },
};

/** The assistant's traces, logs, scores and metrics (Mastra), for the whole deployment. */
export const AssistantTraces: RetentionTarget = {
  name: 'assistant.traces',
  label: {
    en: "The assistant's traces and logs",
    hi: 'असिस्टेंट के ट्रेस और लॉग',
    te: 'అసిస్టెంట్ ట్రేస్‌లు, లాగ్‌లు',
  },
  scope: 'deployment',
  action: 'delete',
  apply: async ({ before, tx }) => ({ count: await expireTraces(tx, before) }),
};

/** Every framework target. */
export const frameworkTargets: RetentionTarget[] = [
  InboundPayloads,
  ChatMessages,
  RelayedEvents,
  RelayedOutbox,
  ExportArchives,
  AssistantTraces,
];
