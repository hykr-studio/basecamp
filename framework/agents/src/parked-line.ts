// What the assistant says about a request that waits for approval: the turn adapter (durable.ts)
// and the scripted model (fake/engine.ts) say the same words.
import { isLang, type Lang, scriptOf, t } from '@hykr/i18n';

type RequestContextLike = { get(key: string): unknown } | undefined;

/** How a turn speaks: its language, whether it is spoken, and where it can show things. */
export type TurnVoice = { lang: Lang; spoken: boolean; surfaces: readonly string[] };

/**
 * What the assistant says about a request waiting for approval. Spoken, or in another language,
 * the framework's short line (the card on screen has the detail; without a screen, what waits and
 * where); otherwise what it asked and that nothing changes until then. The scripted model says
 * the same (`written`), so a parked turn reads alike whether or not the run suspended.
 */
export function parkedLine(summary: string | null | undefined, turn?: Partial<TurnVoice>): string {
  const lang = turn?.lang ?? 'en';
  if (turn?.spoken || lang !== 'en') {
    // "It's on screen" only where there is one; otherwise where to approve it.
    const screen = (turn?.surfaces ?? []).some((s) => s === 'inline' || s === 'canvas');
    return screen
      ? t(lang, 'said.needsApproval')
      : t(lang, 'said.waitingApproval', { summary: summary ?? t(lang, 'said.aChange') });
  }
  return `I've asked for your approval: ${summary ?? 'see Approvals'}. Nothing changes until you approve it.`;
}

/** The turn's voice, from its request context and the person's words (the language they wrote in). */
export function voiceOf(rc: RequestContextLike, text = ''): TurnVoice {
  const pinned = rc?.get('lang');
  const surfaces = (rc?.get('surfaces') as string[] | undefined) ?? ['inline'];
  return {
    lang: isLang(pinned) ? pinned : (scriptOf(text.normalize('NFC')) ?? 'en'),
    spoken: surfaces.includes('speech') || rc?.get('channel') === 'voice',
    surfaces,
  };
}
