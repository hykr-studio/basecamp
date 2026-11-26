import type { VoiceLang } from '@hykr/contracts';
import { type Lang, type Languages, languages } from '@hykr/i18n';

const words = (text: string) => text.trim().split(/\s+/).filter(Boolean).length;

/**
 * The language a voice session answers in, among the application's languages (the set its
 * dispatch carries). Pinned (the person picked one), it never moves. On auto it follows the
 * person, but is sticky: a short or code-mixed utterance ("ok", "haan, add tiles") does not
 * flip it. It moves when a clear sentence (three words or more) is in another language, or
 * when two utterances in a row are.
 */
export class LangState {
  private current: Lang;
  private pinned: boolean;
  private pending: { lang: Lang; count: number } | undefined;

  constructor(
    start: VoiceLang = 'auto',
    private readonly set: Languages = languages(),
    fallback: Lang = 'en',
  ) {
    this.pinned = start !== 'auto' && set.has(start);
    this.current = this.pinned ? start : fallback;
  }

  get lang(): Lang {
    return this.current;
  }

  get isPinned(): boolean {
    return this.pinned;
  }

  /** The language's speech tag (its declared `speech`): what the provider hears and speaks. */
  private speech(lang: Lang): string {
    return (this.set.get(lang) ?? this.set.get('en'))?.speech ?? lang;
  }

  /** What to ask speech-to-text for: detect on auto, or the pinned language. */
  get sttLanguage(): string {
    return this.pinned ? this.speech(this.current) : 'unknown';
  }

  /** The voice the reply is spoken in. */
  get ttsLanguage(): string {
    return this.speech(this.current);
  }

  /** The person changed the language chip. A language the session does not speak is ignored. */
  pin(lang: VoiceLang): boolean {
    if (lang !== 'auto' && !this.set.has(lang)) return false;
    this.pinned = lang !== 'auto';
    if (this.pinned) this.current = lang;
    this.pending = undefined;
    return true;
  }

  /**
   * A final transcript: the language speech-to-text detected (a tag like 'de-AT', if any)
   * and the words. Returns the language to answer this turn in.
   */
  hear(text: string, detected?: string): Lang {
    if (this.pinned) return this.current;
    // A detected language the application does not speak says nothing here: the letters
    // decide instead, rather than falling back to English.
    const heard = this.set.of(detected) ?? this.set.scriptOf(text);
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
