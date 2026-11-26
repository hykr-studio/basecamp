/** Speech to text, as the files feature uses it: the channel's (Sarvam, or the tests' notes). */
export interface Speech {
  transcribe(audio: Buffer, mime: string): Promise<{ text: string; lang?: string }>;
}

/** Inject the speech-to-text service with `@Inject(SPEECH)` (the feature binds the channel's). */
export const SPEECH = Symbol('FILES_SPEECH');
