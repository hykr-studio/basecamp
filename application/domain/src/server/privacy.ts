// What this application says about personal data, beside each module's privacy trait (the
// framework's privacy feature, developer guide 5.27): the services that process it for every
// business, how soon a request is answered, how long the framework's own records of it are kept,
// and that erasing someone for a request the team handles waits for a second person.
import { definePrivacyPolicy, defineProcessor, type RetentionPeriod } from '@hykr/api';
import { atLevel, defineLevelRule } from '@hykr/core';
import { Levels } from './approval-levels.js';

/** The services this application sends personal data to, for every business. */
export const Processors = [
  defineProcessor({
    name: 'Model gateway',
    purpose: {
      en: 'Runs the assistant: reads what people say to it and the records it looks up',
      hi: 'असिस्टेंट चलाता है: लोगों की बातें और देखे गए रिकॉर्ड पढ़ता है',
      te: 'అసిస్టెంట్‌ను నడుపుతుంది: ప్రజలు చెప్పేదీ, చూసే రికార్డులనూ చదువుతుంది',
    },
    data: ['messages', 'records the assistant reads'],
  }),
  defineProcessor({
    name: 'WhatsApp Business Platform',
    purpose: {
      en: 'Carries WhatsApp messages to and from the business',
      hi: 'व्यवसाय के WhatsApp संदेश भेजता और लाता है',
      te: 'వ్యాపారం WhatsApp సందేశాలను పంపుతుంది, తెస్తుంది',
    },
    data: ['phone number', 'messages', 'profile name'],
  }),
  defineProcessor({
    name: 'Email provider',
    purpose: {
      en: 'Sends sign-in codes and notifications by email',
      hi: 'साइन-इन कोड और सूचनाएँ ईमेल से भेजता है',
      te: 'సైన్-ఇన్ కోడ్‌లు, నోటిఫికేషన్‌లను ఈమెయిల్‌లో పంపుతుంది',
    },
    data: ['email address', 'notifications'],
  }),
  defineProcessor({
    name: 'Speech service',
    purpose: {
      en: 'Turns voice notes and calls into words, and words into speech',
      hi: 'वॉइस नोट और कॉल को शब्दों में, और शब्दों को आवाज़ में बदलता है',
      te: 'వాయిస్ నోట్స్, కాల్స్‌ను మాటలుగా, మాటలను స్వరంగా మారుస్తుంది',
    },
    data: ['voice recordings'],
  }),
];

/**
 * A request is answered within 30 days, unless a business sets its own deadline. What stays when
 * someone is forgotten says why on the register: an order's acceptance is the business's proof
 * of what the customer agreed to; the business's own exports and imported files hold the records
 * they copied until their period ends.
 */
export const PrivacyPolicy = definePrivacyPolicy({
  name: 'app',
  respondWithinDays: 30,
  keepReasons: {
    acceptance_evidence: {
      en: 'Kept as proof of what was agreed, for as long as either side may need to show it',
      hi: 'जो तय हुआ उसके प्रमाण के रूप में रखा जाता है, जब तक किसी भी पक्ष को इसे दिखाना पड़ सकता है',
      te: 'ఏం అంగీకరించారో దానికి రుజువుగా ఉంచుతాం, ఏ పక్షానికైనా చూపించాల్సిన అవసరం ఉన్నంత కాలం',
    },
    business_copy: {
      en: "In the business's own exports and imported files made before, until they expire",
      hi: 'पहले बने व्यवसाय के अपने एक्सपोर्ट और इम्पोर्ट की गई फ़ाइलों में, जब तक वे समाप्त न हों',
      te: 'ముందే చేసిన వ్యాపారం సొంత ఎగుమతులు, దిగుమతి ఫైల్‌లలో, అవి గడువు ముగిసే వరకు',
    },
  },
});

/** How long the framework's own records of people are kept here. */
export const RetentionPeriods: RetentionPeriod[] = [
  // Raw WhatsApp payloads, kept for debugging and replay.
  { target: 'channel.inbound-payloads', days: 30 },
  // A person's copy of their data, once made.
  { target: 'privacy.archives', days: 90 },
  // A business export's archive, an import's file and its error report (other people's
  // records), a month after the job finished.
  { target: 'jobs.files', days: 30 },
];

/**
 * Erasing someone cannot be undone: when the team carries out an erasure (a request they
 * reviewed, or one they file for someone), it waits for a second person, as anything
 * `irreversible` does. A person's own erasure is their right and runs as the business says.
 */
export const ErasureIsIrreversible = defineLevelRule({
  name: 'app.privacy',
  on: ['privacy.process', 'privacy.request'],
  decide: ({ op, input, loaded }) => {
    const erase =
      op.name === 'privacy.process'
        ? (loaded as { kind?: string }).kind === 'erase'
        : input?.kind === 'erase' && input.for !== undefined;
    return erase
      ? atLevel(
          Levels.irreversible.name,
          'erasure_irreversible',
          'Erasing a person cannot be undone',
        )
      : null;
  },
});
