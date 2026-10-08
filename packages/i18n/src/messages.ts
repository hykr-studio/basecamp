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
  // WhatsApp and other channels without a screen of their own.
  'channel.choose': 'Choose',
  'channel.moreInApp': 'More in the app: {url}',
  'channel.approveInApp': '{summary}. Approve it in the app: {url}',
  'channel.page': '{title}: open it in the app: {url}',
  'channel.welcome':
    "Hi {name}! I'm the assistant for {business}. I can help with your bookings and to-dos. By chatting here you agree to our privacy notice: {privacyUrl}. Send STOP at any time.",
  'channel.help':
    "I can add, list and complete your to-dos and meetings. Send STOP to stop messages, START to turn reminders back on, 'talk to a person' to reach the team, or 'delete my data' to erase your data. Questions about your data: {grievance}.",
  'channel.stopped':
    "You won't get reminders or offers here any more. Send START to turn reminders back on.",
  'channel.stoppedReminders': 'Reminders are off. Send START to turn them back on.',
  'channel.stoppedOffers':
    "You won't get offers here any more. Reminders about your bookings still come.",
  'channel.started': 'Reminders are on again. Send STOP to turn them off.',
  'channel.handoff': 'Someone from the team will reply here, usually within {replyTime}.',
  'channel.notHeard':
    "Sorry, I couldn't make out that voice note. Could you type it, or send it again?",
  'channel.erased': 'Your data here has been deleted. Thank you for talking to us.',
  'channel.linkAccount': 'Open this link to connect this number to your account: {url}',
  'channel.offTopic':
    'I can only help with things for {business}: your bookings and to-dos. Send HELP to see what I can do.',
  'approval.expired': 'This request has expired. You can still decide it in the app: {url}',
  'approval.done': 'Done: {summary}',
  'approval.rejectedDone': 'Rejected: {summary}. Nothing changed.',
  'approval.alreadyDecided': 'This was already decided.',
  'approval.notYours': "This button isn't for this number.",
  'approval.decideInApp': 'This one is decided in the app, signed in: {url}',
  'approval.askedTeam': "I've asked the team to confirm. I'll tell you here when they do.",
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
  'channel.choose': 'चुनें',
  'channel.moreInApp': 'ऐप में और देखें: {url}',
  'channel.approveInApp': '{summary}। इसे ऐप में मंज़ूर करें: {url}',
  'channel.page': '{title}: इसे ऐप में खोलें: {url}',
  'channel.welcome':
    'नमस्ते {name}! मैं {business} का असिस्टेंट हूँ। मैं आपकी बुकिंग और कामों में मदद कर सकता हूँ। यहाँ बात करके आप हमारी गोपनीयता सूचना से सहमत होते हैं: {privacyUrl}। कभी भी STOP भेजें।',
  'channel.help':
    "मैं आपके काम और मीटिंग जोड़ सकता हूँ, दिखा सकता हूँ और पूरे कर सकता हूँ। संदेश रोकने के लिए STOP, रिमाइंडर फिर से शुरू करने के लिए START, टीम से बात करने के लिए 'किसी इंसान से बात', या अपना डेटा हटाने के लिए 'मेरा डेटा हटाओ' भेजें। आपके डेटा के बारे में सवाल: {grievance}।",
  'channel.stopped': 'अब आपको यहाँ रिमाइंडर या ऑफ़र नहीं मिलेंगे। रिमाइंडर फिर से शुरू करने के लिए START भेजें।',
  'channel.stoppedReminders': 'रिमाइंडर बंद हैं। फिर से शुरू करने के लिए START भेजें।',
  'channel.stoppedOffers': 'अब आपको यहाँ ऑफ़र नहीं मिलेंगे। आपकी बुकिंग के रिमाइंडर आते रहेंगे।',
  'channel.started': 'रिमाइंडर फिर से चालू हैं। बंद करने के लिए STOP भेजें।',
  'channel.handoff': 'टीम का कोई सदस्य यहाँ जवाब देगा, आम तौर पर {replyTime} के अंदर।',
  'channel.notHeard': 'माफ़ कीजिए, वह वॉइस नोट समझ नहीं आया। क्या आप लिखकर या फिर से भेज सकते हैं?',
  'channel.erased': 'यहाँ आपका डेटा हटा दिया गया है। हमसे बात करने के लिए धन्यवाद।',
  'channel.linkAccount': 'इस नंबर को अपने खाते से जोड़ने के लिए यह लिंक खोलें: {url}',
  'channel.offTopic':
    'मैं सिर्फ़ {business} से जुड़े कामों में मदद कर सकता हूँ: आपकी बुकिंग और काम। मैं क्या कर सकता हूँ, यह देखने के लिए HELP भेजें।',
  'approval.expired': 'इस अनुरोध का समय खत्म हो गया है। आप इसे अब भी ऐप में तय कर सकते हैं: {url}',
  'approval.done': 'हो गया: {summary}',
  'approval.rejectedDone': 'अस्वीकार किया: {summary}। कुछ नहीं बदला।',
  'approval.alreadyDecided': 'यह पहले ही तय हो चुका है।',
  'approval.notYours': 'यह बटन इस नंबर के लिए नहीं है।',
  'approval.decideInApp': 'यह ऐप में, साइन इन करके तय होता है: {url}',
  'approval.askedTeam': 'मैंने टीम से पुष्टि करने को कहा है। जब वे करेंगे, मैं आपको यहाँ बताऊँगा।',
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
  'channel.choose': 'ఎంచుకోండి',
  'channel.moreInApp': 'యాప్‌లో మరిన్ని చూడండి: {url}',
  'channel.approveInApp': '{summary}. దీన్ని యాప్‌లో అనుమతించండి: {url}',
  'channel.page': '{title}: దీన్ని యాప్‌లో తెరవండి: {url}',
  'channel.welcome':
    'నమస్తే {name}! నేను {business} అసిస్టెంట్‌ని. మీ బుకింగ్‌లు, పనుల్లో సహాయం చేయగలను. ఇక్కడ మాట్లాడటం ద్వారా మీరు మా గోప్యతా నోటీసుకు అంగీకరిస్తున్నారు: {privacyUrl}. ఎప్పుడైనా STOP పంపండి.',
  'channel.help':
    "నేను మీ పనులు, మీటింగ్‌లను జోడించగలను, చూపించగలను, పూర్తి చేయగలను. సందేశాలు ఆపడానికి STOP, రిమైండర్లు మళ్లీ ప్రారంభించడానికి START, టీమ్‌తో మాట్లాడటానికి 'మనిషితో మాట్లాడాలి', మీ డేటా తొలగించడానికి 'నా డేటా తొలగించు' పంపండి. మీ డేటా గురించి ప్రశ్నలు: {grievance}.",
  'channel.stopped': 'ఇకపై ఇక్కడ మీకు రిమైండర్లు లేదా ఆఫర్లు రావు. రిమైండర్లు మళ్లీ ప్రారంభించడానికి START పంపండి.',
  'channel.stoppedReminders': 'రిమైండర్లు ఆపివేయబడ్డాయి. మళ్లీ ప్రారంభించడానికి START పంపండి.',
  'channel.stoppedOffers': 'ఇకపై మీకు ఇక్కడ ఆఫర్లు రావు. మీ బుకింగ్‌ల రిమైండర్లు వస్తూనే ఉంటాయి.',
  'channel.started': 'రిమైండర్లు మళ్లీ ప్రారంభమయ్యాయి. ఆపడానికి STOP పంపండి.',
  'channel.handoff': 'టీమ్‌లో ఎవరైనా ఇక్కడ సమాధానం ఇస్తారు, సాధారణంగా {replyTime} లోపు.',
  'channel.notHeard': 'క్షమించండి, ఆ వాయిస్ నోట్ అర్థం కాలేదు. టైప్ చేసి లేదా మళ్లీ పంపగలరా?',
  'channel.erased': 'ఇక్కడ మీ డేటా తొలగించబడింది. మాతో మాట్లాడినందుకు ధన్యవాదాలు.',
  'channel.linkAccount': 'ఈ నంబర్‌ను మీ ఖాతాకు కలపడానికి ఈ లింక్ తెరవండి: {url}',
  'channel.offTopic':
    'నేను {business}కి సంబంధించిన విషయాల్లో మాత్రమే సహాయం చేయగలను: మీ బుకింగ్‌లు, పనులు. నేను ఏమి చేయగలనో చూడటానికి HELP పంపండి.',
  'approval.expired': 'ఈ అభ్యర్థన గడువు ముగిసింది. మీరు దీన్ని ఇప్పటికీ యాప్‌లో నిర్ణయించవచ్చు: {url}',
  'approval.done': 'పూర్తయింది: {summary}',
  'approval.rejectedDone': 'తిరస్కరించబడింది: {summary}. ఏమీ మారలేదు.',
  'approval.alreadyDecided': 'ఇది ఇప్పటికే నిర్ణయించబడింది.',
  'approval.notYours': 'ఈ బటన్ ఈ నంబర్ కోసం కాదు.',
  'approval.decideInApp': 'ఇది యాప్‌లో, సైన్ ఇన్ చేసి నిర్ణయించబడుతుంది: {url}',
  'approval.askedTeam': 'నేను టీమ్‌ను నిర్ధారించమని అడిగాను. వారు చేసినప్పుడు ఇక్కడ చెబుతాను.',
};

export const catalogs: Readonly<Record<Lang, Catalog>> = { en, hi, te };

/** A framework phrase in this language, with {name} filled from vars. */
export function t(lang: Lang, key: MessageKey, vars: Record<string, string | number> = {}): string {
  const phrase = catalogs[lang][key] || en[key];
  return phrase.replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in vars ? String(vars[name]) : whole,
  );
}
