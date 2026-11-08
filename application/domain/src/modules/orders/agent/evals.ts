import type { EvalCase, VoiceEvalCase } from '@hykr/agents/script';

/**
 * The orders module's eval conversation (`basecamp eval --module orders`), in order, after its
 * setup saved "Eval kitchen".
 */
export const evalCases: EvalCase[] = [
  {
    why: 'an order is saved whole, and the assistant waits for approval',
    input: 'order Kitchen: 2 Cabinet at 1500, 1 Sink at 800 +18%',
    expect: {
      must: ['list-orders', 'save-order'],
      mustNot: ['transition-orders'],
      replyIncludes: 'approv',
    },
  },
  {
    why: "doesn't invent an id for an order that isn't there",
    input: 'cancel order ORD/1999-00/9999',
    expect: { must: ['list-orders'], mustNot: ['transition-orders'] },
  },
  {
    why: "doesn't revise an order that isn't there",
    input: 'revise order ORD/1999-00/9999',
    expect: { must: ['list-orders'], mustNot: ['revise-order'] },
  },
  {
    why: "makes no PDF of an order that isn't there",
    input: 'pdf of order ORD/1999-00/9999',
    expect: { must: ['list-orders'], mustNot: ['render-document', 'send-document'] },
  },
  {
    why: 'lists orders without changing any',
    input: 'list orders',
    expect: { must: ['list-orders'], mustNot: ['save-order', 'transition-orders', 'revise-order'] },
  },
  {
    why: 'totals orders by status with the summary tool, never by adding up a list',
    input: 'orders by status',
    expect: { must: ['summarize-orders'], mustNot: ['list-orders', 'save-order'] },
  },
  {
    why: 'totals orders by month',
    input: 'order totals by month',
    expect: { must: ['summarize-orders'], mustNot: ['save-order', 'transition-orders'] },
  },
];

/**
 * Spoken turns in English, Hindi and Telugu: the answer in the turn's language, short enough to
 * say (the list and the tiles are on screen). An order number stays as said. The ones not in
 * English are typed on WhatsApp too.
 */
export const voiceEvalCases: VoiceEvalCase[] = [
  {
    lang: 'en',
    why: 'lists orders, briefly (English)',
    input: 'list orders',
    expect: {
      must: ['list-orders'],
      mustNot: ['save-order', 'transition-orders'],
      replyIncludes: 'Eval kitchen',
    },
  },
  {
    lang: 'hi',
    why: 'lists orders (Hindi)',
    input: 'ऑर्डर दिखाओ',
    expect: {
      must: ['list-orders'],
      mustNot: ['save-order', 'transition-orders'],
      replyIncludes: 'Eval kitchen',
    },
  },
  {
    lang: 'te',
    why: 'lists orders (Telugu)',
    input: 'ఆర్డర్లు చూపించు',
    expect: {
      must: ['list-orders'],
      mustNot: ['save-order', 'transition-orders'],
      replyIncludes: 'Eval kitchen',
    },
  },
  {
    lang: 'en',
    why: 'totals by status with the summary tool (English)',
    input: 'orders by status',
    expect: { must: ['summarize-orders'], mustNot: ['list-orders', 'save-order'] },
  },
  {
    lang: 'hi',
    why: 'totals by status with the summary tool (Hindi)',
    input: 'स्थिति के हिसाब से ऑर्डर',
    expect: { must: ['summarize-orders'], mustNot: ['list-orders', 'save-order'] },
  },
  {
    lang: 'te',
    why: 'totals by status with the summary tool (Telugu)',
    input: 'స్థితి వారీగా ఆర్డర్లు',
    expect: { must: ['summarize-orders'], mustNot: ['list-orders', 'save-order'] },
  },
  {
    lang: 'hi',
    why: "no invented id for an order that isn't there (Hindi)",
    input: 'ऑर्डर ORD/1999-00/9999 रद्द करो',
    expect: { must: ['list-orders'], mustNot: ['transition-orders'] },
  },
  {
    lang: 'te',
    why: "no invented id for an order that isn't there (Telugu)",
    input: 'ఆర్డర్ ORD/1999-00/9999 రద్దు చేయి',
    expect: { must: ['list-orders'], mustNot: ['transition-orders'] },
  },
];
