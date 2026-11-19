// Microsoft Graph's change notifications, as a B10 inbound connector. Graph posts a JSON batch
// ({ value: [...] }) to the connection's /webhooks/microsoft-calendar/<id> when the person's
// events change. Each notification carries the clientState we chose when subscribing, the only
// proof the request is Graph's for this connection. Before a subscription exists Graph checks
// the address with a POST carrying ?validationToken=, answered by echoing it (the handshake).
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { defineConnector, type InboundRequest } from '../connector.js';
import { safeEqual } from '../hmac.js';

export const MICROSOFT_CALENDAR_CONNECTOR = 'microsoft-calendar';

/** A change to the person's events. */
export const MICROSOFT_CHANGED_EVENT = 'calendar.changed';

const Credentials = z.object({
  /** Sent back by Graph in every notification's `clientState` (at most 128 characters). */
  clientState: z.string().min(32).max(128),
});
export type MicrosoftSubscriptionCredentials = z.infer<typeof Credentials>;

/** One notification of a batch, as much of it as is read. */
export interface MicrosoftNotification {
  subscriptionId: string;
  clientState?: string;
  changeType?: string;
  resource?: string;
}

/** The batch a request carries, from its exact bytes; null when it is not one. */
export function notificationsOf(
  req: Pick<InboundRequest, 'rawBody'>,
): MicrosoftNotification[] | null {
  if (!req.rawBody?.length) return null;
  try {
    const parsed = JSON.parse(req.rawBody.toString('utf8')) as { value?: unknown };
    if (!Array.isArray(parsed.value) || !parsed.value.length || parsed.value.length > 100)
      return null;
    const out: MicrosoftNotification[] = [];
    for (const v of parsed.value as Record<string, unknown>[]) {
      if (typeof v?.subscriptionId !== 'string' || !v.subscriptionId) return null;
      out.push({
        subscriptionId: v.subscriptionId.slice(0, 100),
        ...(typeof v.clientState === 'string' ? { clientState: v.clientState } : {}),
        ...(typeof v.changeType === 'string' ? { changeType: v.changeType.slice(0, 50) } : {}),
        ...(typeof v.resource === 'string' ? { resource: v.resource.slice(0, 300) } : {}),
      });
    }
    return out;
  } catch {
    return null;
  }
}

/** Graph's validation token: printable, at most 1 KB; anything else is not a handshake. */
export function validationTokenOf(query: Readonly<Record<string, unknown>>): string | null {
  const t = query.validationToken;
  if (typeof t !== 'string' || !t.length || t.length > 1024) return null;
  return [...t].every((c) => c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127) ? t : null;
}

export const microsoftCalendarConnector = defineConnector<MicrosoftSubscriptionCredentials>({
  name: MICROSOFT_CALENDAR_CONNECTOR,
  label: {
    en: 'Microsoft 365 calendar (change notifications)',
    hi: 'Microsoft 365 कैलेंडर (बदलाव की सूचनाएँ)',
    te: 'Microsoft 365 క్యాలెండర్ (మార్పు నోటిఫికేషన్‌లు)',
  },
  description: {
    en: "Microsoft's notices that a connected Outlook calendar changed. Made by the calendar feature when a person connects their calendar.",
    hi: 'Microsoft की सूचना कि जुड़ा हुआ Outlook कैलेंडर बदला। किसी व्यक्ति के कैलेंडर जोड़ने पर कैलेंडर सुविधा इसे बनाती है।',
    te: 'కనెక్ట్ చేసిన Outlook క్యాలెండర్ మారిందని Microsoft నోటీసు. ఒక వ్యక్తి తమ క్యాలెండర్‌ను కనెక్ట్ చేసినప్పుడు క్యాలెండర్ ఫీచర్ దీన్ని సృష్టిస్తుంది.',
  },
  credentials: Credentials,
  generate: () => ({ clientState: randomBytes(32).toString('base64url') }),
  inbound: {
    // Graph signs nothing (without rich notifications): the clientState is all the proof, and
    // whoever has seen one notice can send any other. So the ids are as good as the request,
    // and the handler only reads the calendar again (a repeated notice changes nothing).
    signedIds: true,
    handshake: (req) => (req.rawBody?.length ? null : validationTokenOf(req.query)),
    verify: (req, creds) => {
      const batch = notificationsOf(req);
      if (!batch) return false;
      return batch.every((n) => !!n.clientState && safeEqual(n.clientState, creds.clientState));
    },
    parse: (req) => {
      const batch = notificationsOf(req);
      if (!batch) throw new Error('Not a Microsoft Graph notification');
      // One look per subscription is enough: every change is read again from the delta.
      const subscriptions = [...new Set(batch.map((n) => n.subscriptionId))];
      return subscriptions.map((subscriptionId) => ({
        id: `${subscriptionId}:${randomBytes(8).toString('hex')}`,
        type: MICROSOFT_CHANGED_EVENT,
        data: { subscriptionId },
      }));
    },
  },
});
