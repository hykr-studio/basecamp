// What is at stake in an action, as this product sees it: four approval levels, declared here,
// never in the framework. The framework orders them by rank (the highest wins where decisions
// meet) and applies each level's policy; a business adjusts them in its settings (`approvals`):
// it can make any level wait, let `external` run, change the undo window and the expiry, set the
// thresholds its modules' rules compare with, and name an approver for each amount band.
import { defineApprovalLevel } from '@hykr/contracts';
import { atLevel, defineLevelRule } from '@hykr/core';

export const Levels = {
  /** Reading: never waits. */
  read: defineApprovalLevel({
    name: 'read',
    rank: 0,
    label: { en: 'Read', hi: 'पढ़ना', te: 'చదవడం' },
  }),
  /** A change inside the business: done at once, and can be undone for a few seconds. */
  internal: defineApprovalLevel({
    name: 'internal',
    rank: 1,
    label: { en: 'Internal change', hi: 'अंदरूनी बदलाव', te: 'అంతర్గత మార్పు' },
    policy: { parks: false, undoMs: 10_000 },
  }),
  /**
   * Reaches someone outside the business, which cannot be taken back: waits when the assistant
   * or a background job does it, for the person it is for. A person sending it themselves is
   * the human the send needs. A business may let it run (most keep it).
   */
  external: defineApprovalLevel({
    name: 'external',
    rank: 2,
    label: { en: 'Goes outside', hi: 'बाहर जाता है', te: 'బయటికి వెళ్తుంది' },
    policy: { parks: (p) => p.actor.kind !== 'user', tenantMayLoosen: true },
  }),
  /**
   * Money, legal or irreversible: always waits, for the person the business names for the
   * amount's band (settings `approvals.bands.money`, else holders of approvals.decide), decided
   * in the app, signed in. It waits three days.
   */
  irreversible: defineApprovalLevel({
    name: 'irreversible',
    rank: 3,
    label: { en: 'Money or irreversible', hi: 'पैसा या अपरिवर्तनीय', te: 'డబ్బు లేదా తిరుగులేనిది' },
    policy: {
      approver: { by: { band: 'money' }, channels: ['app'], minAssurance: 'session' },
      expiresInMs: 72 * 60 * 60 * 1000,
    },
  }),
} as const;

/** A template sent to a customer by hand reaches someone outside the business. */
export const SendsGoOutside = defineLevelRule({
  name: 'app.sends',
  on: ['notify.send'],
  decide: () => atLevel(Levels.external.name, 'send_goes_outside', 'It goes to a customer'),
});
