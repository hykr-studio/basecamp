// A messaging channel, in normalized terms: the adapter interface, the WhatsApp adapter, and
// what every channel shares (rendering a turn, keywords, approval buttons). No database, no
// policy, no model: this package only moves messages.
export * from './adapter.js';
export * from './approval-token.js';
export * from './keywords.js';
export * from './render.js';
export * from './split.js';
export {
  createWhatsAppAdapter,
  toGraph,
  WHATSAPP_LIMITS,
  type WhatsAppConfig,
} from './whatsapp/adapter.js';
