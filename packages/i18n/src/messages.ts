import type { Lang } from './lang.js';

/**
 * The framework's own words: what the assistant says about the screen, approvals, and the
 * voice controls. A domain's words (view titles, field names, its verbs) live with the
 * domain, as Labels. `{name}` is filled by t().
 */
const en = {
  // Spoken when the answer is on screen, so the voice does not read a list aloud.
  'said.onScreen': "I've put it on screen.",
  'said.needsApproval': "That needs your OK. I've put it on screen.",
  'said.waitingApproval': '{summary} is waiting for your approval in the app.',
  'said.aChange': 'A change',
  'said.couldNot': "I couldn't do that: {reason}.",
  'said.andMore': 'and {n} more',
  'said.none': 'Nothing here.',
  'said.failed': 'Sorry, that went wrong. Please try again.',

  'approval.waiting': 'Waiting for your approval',
  'approval.approve': 'Approve',
  'approval.reject': 'Reject',
  'approval.askedBy': 'Asked by the assistant',
  'approval.askedByYou': 'Asked by you',
  'approval.keep': 'Keep it',

  'voice.talk': 'Talk',
  'voice.end': 'End',
  'voice.mute': 'Mute',
  'voice.unmute': 'Unmute',
  'voice.connecting': 'Connecting…',
  'voice.listening': 'Listening',
  'voice.thinking': 'Thinking…',
  'voice.speaking': 'Speaking',
  'voice.muted': 'Muted',
  'voice.auto': 'Auto',
  'voice.language': 'Language',
  'voice.noMic': 'Allow the microphone to talk to the assistant.',
  'voice.budget': "You've used today's voice minutes. You can still type.",
  'voice.failed': "Couldn't start voice. You can still type.",
  'voice.noAnswer': "The voice assistant didn't join. Try again, or type.",
} as const;

export type MessageKey = keyof typeof en;
type Catalog = Readonly<Record<MessageKey, string>>;

const hi: Catalog = {
  'said.onScreen': 'मैंने इसे स्क्रीन पर दिखा दिया है।',
  'said.needsApproval': 'इसके लिए आपकी मंज़ूरी चाहिए। मैंने इसे स्क्रीन पर दिखा दिया है।',
  'said.waitingApproval': '{summary} ऐप में आपकी मंज़ूरी का इंतज़ार कर रहा है।',
  'said.aChange': 'एक बदलाव',
  'said.couldNot': 'मैं यह नहीं कर सका: {reason}।',
  'said.andMore': 'और {n} अन्य',
  'said.none': 'यहाँ कुछ नहीं है।',
  'said.failed': 'माफ़ कीजिए, कुछ गड़बड़ हो गई। कृपया फिर कोशिश करें।',

  'approval.waiting': 'आपकी मंज़ूरी का इंतज़ार',
  'approval.approve': 'मंज़ूर करें',
  'approval.reject': 'अस्वीकार करें',
  'approval.askedBy': 'असिस्टेंट ने पूछा',
  'approval.askedByYou': 'आपने पूछा',
  'approval.keep': 'रहने दें',

  'voice.talk': 'बोलें',
  'voice.end': 'बंद करें',
  'voice.mute': 'म्यूट',
  'voice.unmute': 'अनम्यूट',
  'voice.connecting': 'जुड़ रहा है…',
  'voice.listening': 'सुन रहा है',
  'voice.thinking': 'सोच रहा है…',
  'voice.speaking': 'बोल रहा है',
  'voice.muted': 'म्यूट है',
  'voice.auto': 'अपने आप',
  'voice.language': 'भाषा',
  'voice.noMic': 'असिस्टेंट से बात करने के लिए माइक्रोफ़ोन की अनुमति दें।',
  'voice.budget': 'आज के वॉइस मिनट खत्म हो गए। आप अब भी लिख सकते हैं।',
  'voice.failed': 'वॉइस शुरू नहीं हो सका। आप अब भी लिख सकते हैं।',
  'voice.noAnswer': 'वॉइस असिस्टेंट नहीं जुड़ा। फिर कोशिश करें, या लिखें।',
};

const te: Catalog = {
  'said.onScreen': 'నేను దీన్ని స్క్రీన్‌పై చూపించాను.',
  'said.needsApproval': 'దీనికి మీ అనుమతి కావాలి. నేను దీన్ని స్క్రీన్‌పై చూపించాను.',
  'said.waitingApproval': '{summary} యాప్‌లో మీ అనుమతి కోసం వేచి ఉంది.',
  'said.aChange': 'ఒక మార్పు',
  'said.couldNot': 'నేను అది చేయలేకపోయాను: {reason}.',
  'said.andMore': 'మరో {n}',
  'said.none': 'ఇక్కడ ఏమీ లేదు.',
  'said.failed': 'క్షమించండి, ఏదో తప్పు జరిగింది. దయచేసి మళ్లీ ప్రయత్నించండి.',

  'approval.waiting': 'మీ అనుమతి కోసం వేచి ఉంది',
  'approval.approve': 'అనుమతించండి',
  'approval.reject': 'తిరస్కరించండి',
  'approval.askedBy': 'అసిస్టెంట్ అడిగింది',
  'approval.askedByYou': 'మీరు అడిగారు',
  'approval.keep': 'ఉంచండి',

  'voice.talk': 'మాట్లాడండి',
  'voice.end': 'ముగించండి',
  'voice.mute': 'మ్యూట్',
  'voice.unmute': 'అన్‌మ్యూట్',
  'voice.connecting': 'కనెక్ట్ అవుతోంది…',
  'voice.listening': 'వింటోంది',
  'voice.thinking': 'ఆలోచిస్తోంది…',
  'voice.speaking': 'మాట్లాడుతోంది',
  'voice.muted': 'మ్యూట్‌లో ఉంది',
  'voice.auto': 'ఆటో',
  'voice.language': 'భాష',
  'voice.noMic': 'అసిస్టెంట్‌తో మాట్లాడటానికి మైక్రోఫోన్‌ను అనుమతించండి.',
  'voice.budget': 'ఈరోజు వాయిస్ నిమిషాలు అయిపోయాయి. మీరు ఇంకా టైప్ చేయవచ్చు.',
  'voice.failed': 'వాయిస్ ప్రారంభం కాలేదు. మీరు ఇంకా టైప్ చేయవచ్చు.',
  'voice.noAnswer': 'వాయిస్ అసిస్టెంట్ చేరలేదు. మళ్లీ ప్రయత్నించండి, లేదా టైప్ చేయండి.',
};

export const catalogs: Readonly<Record<Lang, Catalog>> = { en, hi, te };

/** A framework phrase in this language, with {name} filled from vars. */
export function t(lang: Lang, key: MessageKey, vars: Record<string, string | number> = {}): string {
  const phrase = catalogs[lang][key] || en[key];
  return phrase.replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in vars ? String(vars[name]) : whole,
  );
}
