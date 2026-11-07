// Requests about personal data: the app's "Your data" screen, and what WhatsApp says when an
// erasure waits for the business.
import { defineMessages } from './define.js';

export const privacyMessages = defineMessages({
  en: {
    'privacy.title': 'Your data',
    'privacy.hint':
      'Ask for a copy of the personal data this business keeps about you, or ask it to erase that data.',
    'privacy.export': 'Get a copy',
    'privacy.erase': 'Erase my data',
    'privacy.eraseConfirm':
      'This erases what the business keeps about you and removes you from it. It cannot be undone.',
    'privacy.eraseYes': 'Erase',
    'privacy.cancel': 'Cancel',
    'privacy.yours': 'Your requests',
    'privacy.none': 'No requests yet.',
    'privacy.kind.export': 'A copy of my data',
    'privacy.kind.erase': 'Erase my data',
    'privacy.status.received': 'Waiting',
    'privacy.status.in_progress': 'In progress',
    'privacy.status.completed': 'Done',
    'privacy.status.refused': 'Refused',
    'privacy.status.failed': 'Failed',
    'privacy.due': 'Answer due {date}',
    'privacy.download': 'Download',
    'privacy.erasureReceived':
      'We have your request to delete your data. We will tell you here once it is done.',
  },
  hi: {
    'privacy.title': 'आपका डेटा',
    'privacy.hint': 'यह व्यवसाय आपके बारे में जो निजी डेटा रखता है, उसकी कॉपी माँगें, या उसे मिटाने को कहें।',
    'privacy.export': 'कॉपी पाएँ',
    'privacy.erase': 'मेरा डेटा मिटाएँ',
    'privacy.eraseConfirm':
      'इससे व्यवसाय के पास आपके बारे में रखा डेटा मिट जाएगा और आप उससे हट जाएँगे। इसे वापस नहीं किया जा सकता।',
    'privacy.eraseYes': 'मिटाएँ',
    'privacy.cancel': 'रद्द करें',
    'privacy.yours': 'आपके अनुरोध',
    'privacy.none': 'अभी कोई अनुरोध नहीं।',
    'privacy.kind.export': 'मेरे डेटा की कॉपी',
    'privacy.kind.erase': 'मेरा डेटा मिटाएँ',
    'privacy.status.received': 'प्रतीक्षा में',
    'privacy.status.in_progress': 'जारी है',
    'privacy.status.completed': 'हो गया',
    'privacy.status.refused': 'अस्वीकार',
    'privacy.status.failed': 'विफल',
    'privacy.due': 'जवाब {date} तक',
    'privacy.download': 'डाउनलोड करें',
    'privacy.erasureReceived': 'आपका डेटा हटाने का अनुरोध हमें मिल गया है। पूरा होते ही हम आपको यहीं बताएँगे।',
  },
  te: {
    'privacy.title': 'మీ డేటా',
    'privacy.hint': 'ఈ వ్యాపారం మీ గురించి ఉంచే వ్యక్తిగత డేటా కాపీని అడగండి, లేదా దాన్ని తొలగించమని అడగండి.',
    'privacy.export': 'కాపీ పొందండి',
    'privacy.erase': 'నా డేటాను తొలగించండి',
    'privacy.eraseConfirm':
      'ఇది వ్యాపారం మీ గురించి ఉంచిన డేటాను తొలగించి, మిమ్మల్ని దాని నుండి తీసివేస్తుంది. దీన్ని వెనక్కి తీసుకోలేరు.',
    'privacy.eraseYes': 'తొలగించండి',
    'privacy.cancel': 'రద్దు చేయండి',
    'privacy.yours': 'మీ అభ్యర్థనలు',
    'privacy.none': 'ఇంకా అభ్యర్థనలు లేవు.',
    'privacy.kind.export': 'నా డేటా కాపీ',
    'privacy.kind.erase': 'నా డేటాను తొలగించండి',
    'privacy.status.received': 'వేచి ఉంది',
    'privacy.status.in_progress': 'జరుగుతోంది',
    'privacy.status.completed': 'పూర్తయింది',
    'privacy.status.refused': 'తిరస్కరించబడింది',
    'privacy.status.failed': 'విఫలమైంది',
    'privacy.due': '{date} లోపు జవాబు',
    'privacy.download': 'డౌన్‌లోడ్ చేయండి',
    'privacy.erasureReceived': 'మీ డేటాను తొలగించే అభ్యర్థన మాకు అందింది. పూర్తయిన వెంటనే ఇక్కడే చెబుతాము.',
  },
});
