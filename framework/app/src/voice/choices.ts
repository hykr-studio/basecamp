import type { VoiceLang } from '@hykr/contracts';
import { languages } from '@hykr/i18n';

/** The language chip's choices: Auto, then each of the application's languages, in order. */
export const voiceChoices = (): VoiceLang[] => ['auto', ...languages().codes];

/** The choice after this one, round again to Auto (a language no longer offered: Auto). */
export function nextVoiceChoice(current: VoiceLang): VoiceLang {
  const all = voiceChoices();
  return all[(all.indexOf(current) + 1) % all.length];
}
