// @hykr/connectors/meta-leads: Facebook and Instagram lead ads, as transport only. Signing in
// with Facebook (a long-lived token, the pages and their tokens), subscribing a page to the app's
// webhook, verifying Meta's signed posts on one URL and fetching each lead. What a lead becomes is
// the application's (a connector handler on `lead` events).
export {
  LEAD_EVENT,
  LEADGEN_EVENT,
  META_GRAPH_VERSION,
  META_LEADS_CONNECTOR,
  type MetaLead,
  type MetaLeadField,
  type MetaLeadNotice,
  type MetaLeadsOptions,
  metaLeads,
  noticesOf,
} from './connector.js';
