import { isLang, type Lang, langOf } from '@app/i18n';
import { Injectable } from '@nestjs/common';
import { config } from '../../config.js';

/** A fake voice note for tests and local runs: its bytes are `FAKE-STT:<lang>:<words>`. */
const FAKE = 'FAKE-STT:';

/**
 * Voice notes to words. Sarvam (Indian languages, the language detected) when a key is set;
 * otherwise only the fake notes tests send. The audio is never stored: only the words go on.
 */
@Injectable()
export class SttService {
  async transcribe(audio: Buffer, mime: string): Promise<{ text: string; lang?: Lang }> {
    if (audio.subarray(0, FAKE.length).toString('utf8') === FAKE) {
      const [lang, ...words] = audio.subarray(FAKE.length).toString('utf8').split(':');
      return { text: words.join(':').trim(), ...(isLang(lang) ? { lang } : {}) };
    }
    if (!config.sarvamKey) throw new Error('No speech-to-text: set SARVAM_API_KEY');
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(audio)], { type: mime }), 'voice-note');
    form.append('model', config.sarvamSttModel);
    form.append('language_code', 'unknown');
    const res = await fetch('https://api.sarvam.ai/speech-to-text', {
      method: 'POST',
      headers: { 'api-subscription-key': config.sarvamKey },
      body: form,
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`Sarvam ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const body = (await res.json()) as { transcript?: string; language_code?: string | null };
    return {
      text: (body.transcript ?? '').trim(),
      ...(body.language_code ? { lang: langOf(body.language_code) } : {}),
    };
  }
}
