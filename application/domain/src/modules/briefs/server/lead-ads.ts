import { defineConnectorHandler } from '@hykr/api';
import { LEAD_EVENT, type MetaLead, metaLeads } from '@hykr/connectors/meta-leads';
import { entityOp, tenantMoney } from '@hykr/core';
import { Brief } from './brief.entity.js';

/**
 * Facebook and Instagram lead ads (decisions B21): the business signs in with Facebook, picks
 * its pages, and each lead someone sends from one of their lead forms reaches this handler with
 * its answers (the framework fetched them). Here a lead becomes a new brief, `source: 'lead_ad'`,
 * owned by the business's default owner, for the team to read like one from the brief form.
 */
export const LeadAdsConnector = metaLeads();

/** The answers Meta's standard lead form questions carry, by their field names. */
const NAME_FIELDS = ['full_name', 'name', 'first_name'];
const PHONE_FIELDS = ['phone_number', 'phone'];

const answer = (lead: MetaLead, names: string[]) => {
  for (const n of names) {
    const v = lead.fields.find((f) => f.name === n)?.values.find((x) => x.trim());
    if (v) return v.trim();
  }
  return undefined;
};

/** A lead as a brief: who (name, number), and every other answer as what they need. */
export function briefOfLead(lead: MetaLead) {
  const first = answer(lead, ['first_name']);
  const last = answer(lead, ['last_name']);
  const name =
    answer(lead, ['full_name', 'name']) ?? ([first, last].filter(Boolean).join(' ') || 'Lead');
  const phone = answer(lead, PHONE_FIELDS);
  const used = new Set([...NAME_FIELDS, 'last_name', ...PHONE_FIELDS]);
  const rest = lead.fields
    .filter((f) => !used.has(f.name) && f.values.some((v) => v.trim()))
    .map((f) => `${f.name.replaceAll('_', ' ')}: ${f.values.join(', ')}`);
  const summary = rest.length ? rest.join('\n') : 'Sent the lead form';
  return {
    name: name.slice(0, 80),
    ...(phone ? { phone: phone.slice(0, 20) } : {}),
    summary: summary.slice(0, 2000),
    notes:
      `Lead ${lead.leadId}, form ${lead.form ?? 'unknown'}${lead.ad ? `, ad ${lead.ad}` : ''}, sent ${lead.createdAt}`.slice(
        0,
        2000,
      ),
    source: 'lead_ad' as const,
  };
}

/**
 * Each lead, as a new brief in the business's own currency (a brief has a budget; a lead names
 * none). Written once: a redelivered lead is the same stored event.
 */
export const BriefFromLeadAd = defineConnectorHandler({
  name: 'briefs.from-lead-ad',
  connector: LeadAdsConnector.name,
  on: [LEAD_EVENT],
  handle: async (event, ctx) => {
    const { currency } = await tenantMoney(ctx.db, event.tenantId);
    await ctx.write(entityOp(Brief, 'create', null), {
      ...briefOfLead(event.data as MetaLead),
      currency,
    });
  },
});
