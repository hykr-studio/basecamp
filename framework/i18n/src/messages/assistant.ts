// What the assistant says about the screen and its own turns: spoken when the answer is on
// screen, so the voice does not read a list aloud.
import { defineMessages } from './define.js';

export const assistantMessages = defineMessages({
  en: {
    'said.onScreen': "I've put it on screen.",
    'said.needsApproval': "That needs your OK. I've put it on screen.",
    'said.waitingApproval': '{summary} is waiting for your approval in the app.',
    'said.aChange': 'A change',
    'said.couldNot': "I couldn't do that: {reason}.",
    'said.andMore': 'and {n} more',
    'said.none': 'Nothing here.',
    'said.failed': 'Sorry, that went wrong. Please try again.',
  },
  hi: {
    'said.onScreen': 'मैंने इसे स्क्रीन पर दिखा दिया है।',
    'said.needsApproval': 'इसके लिए आपकी मंज़ूरी चाहिए। मैंने इसे स्क्रीन पर दिखा दिया है।',
    'said.waitingApproval': '{summary} ऐप में आपकी मंज़ूरी का इंतज़ार कर रहा है।',
    'said.aChange': 'एक बदलाव',
    'said.couldNot': 'मैं यह नहीं कर सका: {reason}।',
    'said.andMore': 'और {n} अन्य',
    'said.none': 'यहाँ कुछ नहीं है।',
    'said.failed': 'माफ़ कीजिए, कुछ गड़बड़ हो गई। कृपया फिर कोशिश करें।',
  },
  te: {
    'said.onScreen': 'నేను దీన్ని స్క్రీన్‌పై చూపించాను.',
    'said.needsApproval': 'దీనికి మీ అనుమతి కావాలి. నేను దీన్ని స్క్రీన్‌పై చూపించాను.',
    'said.waitingApproval': '{summary} యాప్‌లో మీ అనుమతి కోసం వేచి ఉంది.',
    'said.aChange': 'ఒక మార్పు',
    'said.couldNot': 'నేను అది చేయలేకపోయాను: {reason}.',
    'said.andMore': 'మరో {n}',
    'said.none': 'ఇక్కడ ఏమీ లేదు.',
    'said.failed': 'క్షమించండి, ఏదో తప్పు జరిగింది. దయచేసి మళ్లీ ప్రయత్నించండి.',
  },
});
