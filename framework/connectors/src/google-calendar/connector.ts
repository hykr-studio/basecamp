// Google Calendar's push notifications, as a B10 inbound connector: Google posts to the
// connection's /webhooks/google-calendar/<id> with headers only (no body) whenever the watched
// calendar's events change. The channel token we chose when opening the channel proves the
// request is Google's for this connection.
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { defineConnector, readHeader } from '../connector.js';
import { safeEqual } from '../hmac.js';

export const GOOGLE_CALENDAR_CONNECTOR = 'google-calendar';

/** An initial handshake ('sync') or a change ('exists', 'not_exists'). */
export const CHANGED_EVENT = 'calendar.changed';
export const HANDSHAKE_EVENT = 'calendar.sync';

const Credentials = z.object({
  /** Sent back by Google in X-Goog-Channel-Token on every notification. */
  channelToken: z.string().min(32).max(256),
});
export type GoogleChannelCredentials = z.infer<typeof Credentials>;

/** A notification's headers, read. */
export interface GoogleNotification {
  channelId: string;
  resourceId: string;
  resourceState: string;
  messageNumber: string;
  expiration?: string;
}

const HEADER = {
  token: 'x-goog-channel-token',
  channel: 'x-goog-channel-id',
  resource: 'x-goog-resource-id',
  state: 'x-goog-resource-state',
  number: 'x-goog-message-number',
  expiration: 'x-goog-channel-expiration',
} as const;

export const googleCalendarConnector = defineConnector<GoogleChannelCredentials>({
  name: GOOGLE_CALENDAR_CONNECTOR,
  label: {
    en: 'Google Calendar (push channel)',
    hi: 'Google Calendar (पुश चैनल)',
    te: 'Google Calendar (పుష్ ఛానల్)',
  },
  description: {
    en: "Google's notices that a connected calendar changed. Made by the calendar feature when a person connects their calendar.",
    hi: 'Google की सूचना कि जुड़ा हुआ कैलेंडर बदला। किसी व्यक्ति के कैलेंडर जोड़ने पर कैलेंडर सुविधा इसे बनाती है।',
    te: 'కనెక్ట్ చేసిన క్యాలెండర్ మారిందని Google నోటీసు. ఒక వ్యక్తి తమ క్యాలెండర్‌ను కనెక్ట్ చేసినప్పుడు క్యాలెండర్ ఫీచర్ దీన్ని సృష్టిస్తుంది.',
  },
  credentials: Credentials,
  generate: () => ({ channelToken: randomBytes(32).toString('base64url') }),
  inbound: {
    bodyless: true,
    // Google signs nothing: the channel token is all the proof, and whoever has seen one notice
    // can send any other. So the channel and message number are as good as the request itself,
    // and the handler only reads the calendar again (a repeated notice changes nothing).
    signedIds: true,
    verify: (req, creds) => {
      const token = readHeader(req.headers, HEADER.token);
      if (!token || !safeEqual(token, creds.channelToken)) return false;
      return !!readHeader(req.headers, HEADER.channel) && !!readHeader(req.headers, HEADER.state);
    },
    parse: (req) => {
      const n = notificationOf(req.headers);
      return [
        {
          id: `${n.channelId}:${n.messageNumber}`,
          type: n.resourceState === 'sync' ? HANDSHAKE_EVENT : CHANGED_EVENT,
          data: n,
        },
      ];
    },
  },
});

/** The notification's headers. Throws when one Google always sends is missing. */
export function notificationOf(headers: Parameters<typeof readHeader>[0]): GoogleNotification {
  const get = (name: string) => readHeader(headers, name);
  const channelId = get(HEADER.channel);
  const resourceState = get(HEADER.state);
  const messageNumber = get(HEADER.number);
  if (!channelId || !resourceState || !messageNumber)
    throw new Error('Not a Google Calendar notification');
  return {
    channelId,
    resourceId: get(HEADER.resource) ?? '',
    resourceState,
    messageNumber,
    ...(get(HEADER.expiration) ? { expiration: get(HEADER.expiration) } : {}),
  };
}

/** The headers Google sends with a notification: what the fake posts. */
export function notificationHeaders(a: {
  channelId: string;
  token: string;
  resourceId: string;
  state: 'sync' | 'exists' | 'not_exists';
  messageNumber: number;
  expiration?: number;
}): Record<string, string> {
  return {
    [HEADER.channel]: a.channelId,
    [HEADER.token]: a.token,
    [HEADER.resource]: a.resourceId,
    [HEADER.state]: a.state,
    [HEADER.number]: String(a.messageNumber),
    ...(a.expiration ? { [HEADER.expiration]: new Date(a.expiration).toUTCString() } : {}),
  };
}
