// Integrations: what a business's managers are told when a connection made by signing in stops
// working, or will soon (decisions B21), and the app's integrations screen.
import { defineMessages } from './define.js';

export const integrationMessages = defineMessages({
  en: {
    'integrations.title': 'Integrations',
    'integrations.connections': 'Connections',
    'integrations.none': 'Nothing is connected yet.',
    'integrations.connectNew': 'Connect a service',
    'integrations.connect': 'Connect',
    'integrations.notOffered': 'Not set up on this server',
    'integrations.connecting': 'Connecting…',
    'integrations.connected': 'Connected',
    'integrations.signInStopped': 'Not connected: {reason}',
    'integrations.connectedRow': 'Connected',
    'integrations.needsReauthRow': 'Needs signing in again',
    'integrations.disconnectedRow': 'Disconnected',
    'integrations.reconnect': 'Sign in again',
    'integrations.disconnect': 'Disconnect',
    'integrations.accounts': 'Receive from',
    'integrations.saveAccounts': 'Save',
    'integrations.accountsSaved': 'Saved',
    'integrations.someNotSubscribed': 'Saved, but some could not be subscribed: try again',
    'integrations.needsReauth': '{label} needs signing in again',
    'integrations.needsReauthBody':
      'The connection to {label} stopped working, so nothing arrives from it. Sign it in again in Integrations.',
    'integrations.needsReauthEmail':
      'The connection to {label} stopped working, so nothing arrives from it. Sign it in again: {url}',
    'integrations.reauthSoon': '{label} needs signing in again soon',
    'integrations.reauthSoonBody':
      'The connection to {label} ends on {date}. Sign it in again in Integrations before then.',
    'integrations.reauthSoonEmail':
      'The connection to {label} ends on {date}. Sign it in again before then: {url}',
  },
  hi: {
    'integrations.title': 'इंटीग्रेशन',
    'integrations.connections': 'कनेक्शन',
    'integrations.none': 'अभी कुछ भी जुड़ा नहीं है।',
    'integrations.connectNew': 'कोई सेवा जोड़ें',
    'integrations.connect': 'जोड़ें',
    'integrations.notOffered': 'इस सर्वर पर सेट नहीं है',
    'integrations.connecting': 'जोड़ा जा रहा है…',
    'integrations.connected': 'जुड़ गया',
    'integrations.signInStopped': 'नहीं जुड़ा: {reason}',
    'integrations.connectedRow': 'जुड़ा हुआ',
    'integrations.needsReauthRow': 'फिर से साइन इन करना होगा',
    'integrations.disconnectedRow': 'जुड़ा नहीं',
    'integrations.reconnect': 'फिर से साइन इन करें',
    'integrations.disconnect': 'हटाएँ',
    'integrations.accounts': 'यहाँ से पाएँ',
    'integrations.saveAccounts': 'सहेजें',
    'integrations.accountsSaved': 'सहेजा गया',
    'integrations.someNotSubscribed': 'सहेजा गया, पर कुछ सब्सक्राइब नहीं हो सके: फिर से कोशिश करें',
    'integrations.needsReauth': '{label} में फिर से साइन इन करना होगा',
    'integrations.needsReauthBody':
      '{label} से कनेक्शन ने काम करना बंद कर दिया है, इसलिए वहाँ से कुछ नहीं आ रहा। Integrations में फिर से साइन इन करें।',
    'integrations.needsReauthEmail':
      '{label} से कनेक्शन ने काम करना बंद कर दिया है, इसलिए वहाँ से कुछ नहीं आ रहा। फिर से साइन इन करें: {url}',
    'integrations.reauthSoon': '{label} में जल्द ही फिर से साइन इन करना होगा',
    'integrations.reauthSoonBody':
      '{label} से कनेक्शन {date} को ख़त्म हो जाएगा। उससे पहले Integrations में फिर से साइन इन करें।',
    'integrations.reauthSoonEmail':
      '{label} से कनेक्शन {date} को ख़त्म हो जाएगा। उससे पहले फिर से साइन इन करें: {url}',
  },
  te: {
    'integrations.title': 'ఇంటిగ్రేషన్‌లు',
    'integrations.connections': 'కనెక్షన్‌లు',
    'integrations.none': 'ఇంకా ఏదీ కనెక్ట్ కాలేదు.',
    'integrations.connectNew': 'ఒక సేవను కనెక్ట్ చేయండి',
    'integrations.connect': 'కనెక్ట్ చేయండి',
    'integrations.notOffered': 'ఈ సర్వర్‌లో సెటప్ చేయలేదు',
    'integrations.connecting': 'కనెక్ట్ అవుతోంది…',
    'integrations.connected': 'కనెక్ట్ అయింది',
    'integrations.signInStopped': 'కనెక్ట్ కాలేదు: {reason}',
    'integrations.connectedRow': 'కనెక్ట్ అయి ఉంది',
    'integrations.needsReauthRow': 'మళ్ళీ సైన్ ఇన్ చేయాలి',
    'integrations.disconnectedRow': 'డిస్‌కనెక్ట్ అయింది',
    'integrations.reconnect': 'మళ్ళీ సైన్ ఇన్ చేయండి',
    'integrations.disconnect': 'డిస్‌కనెక్ట్ చేయండి',
    'integrations.accounts': 'వీటి నుండి స్వీకరించండి',
    'integrations.saveAccounts': 'సేవ్ చేయండి',
    'integrations.accountsSaved': 'సేవ్ అయింది',
    'integrations.someNotSubscribed': 'సేవ్ అయింది, కానీ కొన్నింటికి సబ్‌స్క్రైబ్ కాలేదు: మళ్ళీ ప్రయత్నించండి',
    'integrations.needsReauth': '{label}లో మళ్ళీ సైన్ ఇన్ చేయాలి',
    'integrations.needsReauthBody':
      '{label}తో కనెక్షన్ పని చేయడం ఆగిపోయింది, కాబట్టి దాని నుండి ఏదీ రావడం లేదు. Integrationsలో మళ్ళీ సైన్ ఇన్ చేయండి.',
    'integrations.needsReauthEmail':
      '{label}తో కనెక్షన్ పని చేయడం ఆగిపోయింది, కాబట్టి దాని నుండి ఏదీ రావడం లేదు. మళ్ళీ సైన్ ఇన్ చేయండి: {url}',
    'integrations.reauthSoon': '{label}లో త్వరలో మళ్ళీ సైన్ ఇన్ చేయాలి',
    'integrations.reauthSoonBody':
      '{label}తో కనెక్షన్ {date}న ముగుస్తుంది. అంతకు ముందే Integrationsలో మళ్ళీ సైన్ ఇన్ చేయండి.',
    'integrations.reauthSoonEmail':
      '{label}తో కనెక్షన్ {date}న ముగుస్తుంది. అంతకు ముందే మళ్ళీ సైన్ ఇన్ చేయండి: {url}',
  },
});
