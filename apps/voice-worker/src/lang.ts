import type { VoiceLang } from '@app/contracts';
import { isLang, type Lang, langOf, scriptOf } from '@app/i18n';

const words = (text: string) => text.trim().split(/\s+/).filter(Boolean).length;

/**
 * The language a voice session answers in. Pinned (the person picked one), it never moves.
 * On auto it follows the person, but is sticky: a short or code-mixed utterance ("ok",
 * "haan, add tiles") does not flip it. It moves when a clear sentence (three words or more)
 * is in another language, or when two utterances in a row are.
 */
export class LangState {
  private current: Lang;
  private pinned: boolean;
  private pending: { lang: Lang; count: number } | undefined;

  constructor(start: VoiceLang = 'auto', fallback: Lang = 'en') {
    this.pinned = start !== 'auto';
    this.current = this.pinned ? langOf(start) : fallback;
  }

  get lang(): Lang {
    return this.current;
  }

  get isPinned(): boolean {
    return this.pinned;
  }

  /** What to ask speech-to-text for: detect on auto, or the pinned language. */
  get sttLanguage(): string {
    return this.pinned ? `${this.current}-IN` : 'unknown';
  }

  /** The voice the reply is spoken in. */
  get ttsLanguage(): `${Lang}-IN` {
    return `${this.current}-IN`;
  }

  /** The person changed the language chip. */
  pin(lang: VoiceLang) {
    this.pinned = lang !== 'auto';
    if (this.pinned) this.current = langOf(lang);
    this.pending = undefined;
  }

  /**
   * A final transcript: the language speech-to-text detected (a tag like 'te-IN', if any)
   * and the words. Returns the language to answer this turn in.
   */
  hear(text: string, detected?: string): Lang {
    if (this.pinned) return this.current;
    // A detected language the product does not speak (Tamil, Bengali…) says nothing here:
    // the script decides instead, rather than falling back to English.
    const base = detected?.toLowerCase().split(/[-_]/)[0];
    const heard = isLang(base) ? langOf(detected) : scriptOf(text);
    if (!heard || heard === this.current) {
      this.pending = undefined;
      return this.current;
    }
    const count = this.pending?.lang === heard ? this.pending.count + 1 : 1;
    if (words(text) >= 3 || count >= 2) {
      this.current = heard;
      this.pending = undefined;
    } else {
      this.pending = { lang: heard, count };
    }
    return this.current;
  }
}
