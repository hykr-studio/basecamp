// Push in a browser (web push): the strip that offers it, and the control in the person's card.
import { defineMessages } from './define.js';

export const pushMessages = defineMessages({
  en: {
    'push.turnOn': 'Turn on notifications',
    'push.offer':
      'Get a notification in this browser when something needs you: an approval, a reply.',
    'push.notNow': 'Not now',
    'push.on': 'Notifications are on in this browser',
    'push.turnOff': 'Turn off',
    'push.blocked':
      "Notifications are blocked for this site. Allow them in the browser's site settings.",
    'push.failed': 'Notifications could not be turned on: {reason}',
  },
  hi: {
    'push.turnOn': 'सूचनाएँ चालू करें',
    'push.offer': 'जब आपकी ज़रूरत हो, जैसे कोई मंज़ूरी या जवाब, तो इस ब्राउज़र में सूचना पाएँ।',
    'push.notNow': 'अभी नहीं',
    'push.on': 'इस ब्राउज़र में सूचनाएँ चालू हैं',
    'push.turnOff': 'बंद करें',
    'push.blocked': 'इस साइट के लिए सूचनाएँ रोकी गई हैं। ब्राउज़र की साइट सेटिंग में इन्हें अनुमति दें।',
    'push.failed': 'सूचनाएँ चालू नहीं हो सकीं: {reason}',
  },
  te: {
    'push.turnOn': 'నోటిఫికేషన్‌లను ఆన్ చేయండి',
    'push.offer': 'మీ అవసరం ఉన్నప్పుడు, ఒక ఆమోదం లేదా జవాబు వంటివి, ఈ బ్రౌజర్‌లో నోటిఫికేషన్ పొందండి.',
    'push.notNow': 'ఇప్పుడు కాదు',
    'push.on': 'ఈ బ్రౌజర్‌లో నోటిఫికేషన్‌లు ఆన్‌లో ఉన్నాయి',
    'push.turnOff': 'ఆఫ్ చేయండి',
    'push.blocked': 'ఈ సైట్‌కు నోటిఫికేషన్‌లు నిరోధించబడ్డాయి. బ్రౌజర్ సైట్ సెట్టింగ్‌లలో వాటిని అనుమతించండి.',
    'push.failed': 'నోటిఫికేషన్‌లను ఆన్ చేయలేకపోయాము: {reason}',
  },
});
