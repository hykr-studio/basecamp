import { z } from 'zod';
import { defineTemplate } from '../define-template.js';

/** The code that links a number to an account (Meta fixes most of an authentication template). */
export const LoginCode = defineTemplate({
  name: 'login_code_v1',
  category: 'authentication',
  params: z.object({ code: z.string().regex(/^\d{6}$/) }),
  body: {
    en: '{{code}} is your code to connect this number to your account. It expires in 10 minutes.',
    hi: '{{code}} इस नंबर को आपके खाते से जोड़ने का कोड है। यह 10 मिनट में खत्म हो जाएगा।',
    te: '{{code}} ఈ నంబర్‌ను మీ ఖాతాకు కలపడానికి కోడ్. ఇది 10 నిమిషాల్లో ముగుస్తుంది.',
  },
  example: { code: '482913' },
});

/** An approval waiting for this person, outside the 24-hour window: decide with a tap. */
export const ApprovalRequest = defineTemplate({
  name: 'approval_request_v1',
  category: 'utility',
  params: z.object({ summary: z.string().max(200) }),
  body: {
    en: 'Waiting for your approval: {{summary}}.',
    hi: 'आपकी मंज़ूरी का इंतज़ार: {{summary}}।',
    te: 'మీ అనుమతి కోసం వేచి ఉంది: {{summary}}.',
  },
  buttons: [
    { type: 'quick_reply', id: 'approve', text: { en: 'Approve', hi: 'मंज़ूर करें', te: 'అనుమతించండి' } },
    {
      type: 'quick_reply',
      id: 'reject',
      text: { en: 'Reject', hi: 'अस्वीकार करें', te: 'తిరస్కరించండి' },
    },
  ],
  example: { summary: 'Delete "Order tiles"' },
});

/** The outcome of a request someone else decided (a customer asked; ops approved). */
export const ApprovalOutcome = defineTemplate({
  name: 'approval_outcome_v1',
  category: 'utility',
  params: z.object({ summary: z.string().max(200), outcome: z.string().max(40) }),
  body: {
    en: 'Your request "{{summary}}" was {{outcome}}.',
    hi: 'आपका अनुरोध "{{summary}}" {{outcome}}।',
    te: 'మీ అభ్యర్థన "{{summary}}" {{outcome}}.',
  },
  example: { summary: 'Cancel the site visit', outcome: 'approved' },
});

/** A staff reply when the customer's 24-hour window has closed. */
export const HandoffReply = defineTemplate({
  name: 'handoff_reply_v1',
  category: 'utility',
  params: z.object({ business: z.string().max(60), message: z.string().max(600) }),
  body: {
    en: 'A reply from {{business}}: {{message}}',
    hi: '{{business}} की ओर से जवाब: {{message}}',
    te: '{{business}} నుండి సమాధానం: {{message}}',
  },
  example: { business: 'Agentic Stack Demo', message: 'Your visit is moved to Friday at 4 pm.' },
});

/** Example only: marketing needs explicit consent, an opt-out, and costs money per send. */
export const MonthlyUpdate = defineTemplate({
  name: 'monthly_update_v1',
  category: 'marketing',
  params: z.object({ name: z.string().max(60), news: z.string().max(300) }),
  body: {
    en: 'Hi {{name}}, this month: {{news}}',
    hi: 'नमस्ते {{name}}, इस महीने: {{news}}',
    te: 'నమస్తే {{name}}, ఈ నెల: {{news}}',
  },
  buttons: [
    {
      type: 'quick_reply',
      id: 'stop_offers',
      text: { en: 'Stop offers', hi: 'ऑफ़र बंद करें', te: 'ఆఫర్లు ఆపండి' },
    },
  ],
  example: { name: 'Asha', news: 'Free site visits on Saturdays.' },
});

export const frameworkTemplates = [
  LoginCode,
  ApprovalRequest,
  ApprovalOutcome,
  HandoffReply,
  MonthlyUpdate,
];
