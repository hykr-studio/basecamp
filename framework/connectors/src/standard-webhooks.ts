// The built-in inbound connector for any sender that signs the Standard Webhooks way (the same
// scheme Basecamp's outbound webhooks use): `webhook-id`, `webhook-timestamp` and
// `webhook-signature` headers, a `whsec_` secret, a body `{ type, data }`.
import { z } from 'zod';
import { defineConnector, readHeader } from './connector.js';
import { generateWebhookSecret, verifyWebhook, WEBHOOK_HEADERS } from './signature.js';

const Credentials = z.object({
  /** `whsec_<base64>`: what the sender signs with. */
  secret: z.string().min(16).max(200),
});

const Body = z.object({ type: z.string().min(1).max(200), data: z.unknown().optional() });

export const standardWebhooks = defineConnector<z.infer<typeof Credentials>>({
  name: 'standard-webhooks',
  label: {
    en: 'Signed webhooks (Standard Webhooks)',
    hi: 'हस्ताक्षरित वेबहुक (Standard Webhooks)',
    te: 'సంతకం చేసిన వెబ్‌హుక్‌లు (Standard Webhooks)',
  },
  description: {
    en: 'Any system that signs its webhooks with a shared secret, the Standard Webhooks way.',
    hi: 'कोई भी सिस्टम जो अपने वेबहुक को साझा गुप्त कुंजी से Standard Webhooks तरीके से साइन करता है।',
    te: 'Standard Webhooks పద్ధతిలో పంచుకున్న రహస్య కీతో వెబ్‌హుక్‌లపై సంతకం చేసే ఏ సిస్టమ్ అయినా.',
  },
  credentials: Credentials,
  generate: () => ({ secret: generateWebhookSecret() }),
  inbound: {
    // `webhook-id` is signed: the content is "<id>.<timestamp>.<body>".
    signedIds: true,
    verify: (req, creds, now) =>
      verifyWebhook({ secret: creds.secret, headers: req.headers, body: req.rawBody, now }).ok,
    parse: (req) => {
      const body = Body.parse(req.body);
      const id = readHeader(req.headers, WEBHOOK_HEADERS.id) ?? '';
      return [{ id, type: body.type, data: body.data ?? null }];
    },
  },
});
