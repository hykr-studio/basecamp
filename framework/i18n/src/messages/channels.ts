// WhatsApp and other channels without a screen of their own.
import { defineMessages } from './define.js';

export const channelMessages = defineMessages({
  en: {
    'channel.choose': 'Choose',
    // What the assistant helps with, when the application doesn't say (ServerDefinition.channel).
    'channel.does': 'I can help you here with what we do.',
    'channel.moreInApp': 'More in the app: {url}',
    'channel.approveInApp': '{summary}. Approve it in the app: {url}',
    'channel.page': '{title}: open it in the app: {url}',
    'channel.welcome':
      "Hi {name}! I'm the assistant for {business}. {does} By chatting here you agree to our privacy notice: {privacyUrl}. Send STOP at any time.",
    'channel.help':
      "{does} Send STOP to stop messages, START to turn reminders back on, 'talk to a person' to reach the team, or 'delete my data' to erase your data. Questions about your data: {grievance}.",
    // HELP when the business has named nobody for personal data (nor has the deployment).
    'channel.helpNoContact':
      "{does} Send STOP to stop messages, START to turn reminders back on, 'talk to a person' to reach the team, or 'delete my data' to erase your data. No contact for questions about your data is named yet: ask the team with 'talk to a person'.",
    'channel.stopped':
      "You won't get reminders or offers here any more. Send START to turn reminders back on.",
    'channel.stoppedReminders': 'Reminders are off. Send START to turn them back on.',
    'channel.stoppedOffers': "You won't get offers here any more. Reminders still come.",
    'channel.started': 'Reminders are on again. Send STOP to turn them off.',
    'channel.handoff': 'Someone from the team will reply here, usually within {replyTime}.',
    'channel.notHeard':
      "Sorry, I couldn't make out that voice note. Could you type it, or send it again?",
    'channel.erased': 'Your data here has been deleted. Thank you for talking to us.',
    'channel.linkAccount': 'Open this link to connect this number to your account: {url}',
    'channel.offTopic':
      'I can only help with things for {business}. Send HELP to see what I can do.',
  },
  hi: {
    'channel.choose': 'चुनें',
    'channel.does': 'मैं यहाँ हमारे काम से जुड़ी आपकी मदद कर सकता हूँ।',
    'channel.moreInApp': 'ऐप में और देखें: {url}',
    'channel.approveInApp': '{summary}। इसे ऐप में मंज़ूर करें: {url}',
    'channel.page': '{title}: इसे ऐप में खोलें: {url}',
    'channel.welcome':
      'नमस्ते {name}! मैं {business} का असिस्टेंट हूँ। {does} यहाँ बात करके आप हमारी गोपनीयता सूचना से सहमत होते हैं: {privacyUrl}। कभी भी STOP भेजें।',
    'channel.help':
      "{does} संदेश रोकने के लिए STOP, रिमाइंडर फिर से शुरू करने के लिए START, टीम से बात करने के लिए 'किसी इंसान से बात', या अपना डेटा हटाने के लिए 'मेरा डेटा हटाओ' भेजें। आपके डेटा के बारे में सवाल: {grievance}।",
    'channel.helpNoContact':
      "{does} संदेश रोकने के लिए STOP, रिमाइंडर फिर से शुरू करने के लिए START, टीम से बात करने के लिए 'किसी इंसान से बात', या अपना डेटा हटाने के लिए 'मेरा डेटा हटाओ' भेजें। आपके डेटा के बारे में सवालों के लिए अभी कोई संपर्क तय नहीं है: 'किसी इंसान से बात' भेजकर टीम से पूछें।",
    'channel.stopped': 'अब आपको यहाँ रिमाइंडर या ऑफ़र नहीं मिलेंगे। रिमाइंडर फिर से शुरू करने के लिए START भेजें।',
    'channel.stoppedReminders': 'रिमाइंडर बंद हैं। फिर से शुरू करने के लिए START भेजें।',
    'channel.stoppedOffers': 'अब आपको यहाँ ऑफ़र नहीं मिलेंगे। रिमाइंडर आते रहेंगे।',
    'channel.started': 'रिमाइंडर फिर से चालू हैं। बंद करने के लिए STOP भेजें।',
    'channel.handoff': 'टीम का कोई सदस्य यहाँ जवाब देगा, आम तौर पर {replyTime} के अंदर।',
    'channel.notHeard': 'माफ़ कीजिए, वह वॉइस नोट समझ नहीं आया। क्या आप लिखकर या फिर से भेज सकते हैं?',
    'channel.erased': 'यहाँ आपका डेटा हटा दिया गया है। हमसे बात करने के लिए धन्यवाद।',
    'channel.linkAccount': 'इस नंबर को अपने खाते से जोड़ने के लिए यह लिंक खोलें: {url}',
    'channel.offTopic':
      'मैं सिर्फ़ {business} से जुड़े कामों में मदद कर सकता हूँ। मैं क्या कर सकता हूँ, यह देखने के लिए HELP भेजें।',
  },
  te: {
    'channel.choose': 'ఎంచుకోండి',
    'channel.does': 'మా సేవలకు సంబంధించి ఇక్కడ మీకు సహాయం చేయగలను.',
    'channel.moreInApp': 'యాప్‌లో మరిన్ని చూడండి: {url}',
    'channel.approveInApp': '{summary}. దీన్ని యాప్‌లో అనుమతించండి: {url}',
    'channel.page': '{title}: దీన్ని యాప్‌లో తెరవండి: {url}',
    'channel.welcome':
      'నమస్తే {name}! నేను {business} అసిస్టెంట్‌ని. {does} ఇక్కడ మాట్లాడటం ద్వారా మీరు మా గోప్యతా నోటీసుకు అంగీకరిస్తున్నారు: {privacyUrl}. ఎప్పుడైనా STOP పంపండి.',
    'channel.help':
      "{does} సందేశాలు ఆపడానికి STOP, రిమైండర్లు మళ్లీ ప్రారంభించడానికి START, టీమ్‌తో మాట్లాడటానికి 'మనిషితో మాట్లాడాలి', మీ డేటా తొలగించడానికి 'నా డేటా తొలగించు' పంపండి. మీ డేటా గురించి ప్రశ్నలు: {grievance}.",
    'channel.helpNoContact':
      "{does} సందేశాలు ఆపడానికి STOP, రిమైండర్లు మళ్లీ ప్రారంభించడానికి START, టీమ్‌తో మాట్లాడటానికి 'మనిషితో మాట్లాడాలి', మీ డేటా తొలగించడానికి 'నా డేటా తొలగించు' పంపండి. మీ డేటా గురించి ప్రశ్నలకు ఇంకా ఎవరి సంప్రదింపు వివరాలూ ఇవ్వలేదు: 'మనిషితో మాట్లాడాలి' పంపి టీమ్‌ను అడగండి.",
    'channel.stopped': 'ఇకపై ఇక్కడ మీకు రిమైండర్లు లేదా ఆఫర్లు రావు. రిమైండర్లు మళ్లీ ప్రారంభించడానికి START పంపండి.',
    'channel.stoppedReminders': 'రిమైండర్లు ఆపివేయబడ్డాయి. మళ్లీ ప్రారంభించడానికి START పంపండి.',
    'channel.stoppedOffers': 'ఇకపై మీకు ఇక్కడ ఆఫర్లు రావు. రిమైండర్లు వస్తూనే ఉంటాయి.',
    'channel.started': 'రిమైండర్లు మళ్లీ ప్రారంభమయ్యాయి. ఆపడానికి STOP పంపండి.',
    'channel.handoff': 'టీమ్‌లో ఎవరైనా ఇక్కడ సమాధానం ఇస్తారు, సాధారణంగా {replyTime} లోపు.',
    'channel.notHeard': 'క్షమించండి, ఆ వాయిస్ నోట్ అర్థం కాలేదు. టైప్ చేసి లేదా మళ్లీ పంపగలరా?',
    'channel.erased': 'ఇక్కడ మీ డేటా తొలగించబడింది. మాతో మాట్లాడినందుకు ధన్యవాదాలు.',
    'channel.linkAccount': 'ఈ నంబర్‌ను మీ ఖాతాకు కలపడానికి ఈ లింక్ తెరవండి: {url}',
    'channel.offTopic':
      'నేను {business}కి సంబంధించిన విషయాల్లో మాత్రమే సహాయం చేయగలను. నేను ఏమి చేయగలనో చూడటానికి HELP పంపండి.',
  },
});
