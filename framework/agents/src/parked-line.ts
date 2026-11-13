// What the assistant says about a request that waits for approval: the turn adapter (durable.ts)
// and the scripted model (fake/engine.ts) say the same words.
import { isLang, type Lang, scriptOf, t } from '@hykr/i18n';

type RequestContextLike = { get(key: string): unknown } | undefined;

/** How a turn speaks: its language, whether it is spoken, and where it can show things. */
export type TurnVoice = { lang: Lang; spoken: boolean; surfaces: readonly string[] };

/** What the line needs to know about a parked request: what waits, and who decides it. */
export type ParkedApproval = { summary?: string | null; canDecide?: boolean };

/**
 * What the assistant says about a request waiting for approval, and who decides it: the person
 * (their approval) or someone else (`canDecide` false: the team was asked). Written, what it
 * asked and that nothing changes until then, in the turn's language. Spoken, the framework's
 * short line (the card on screen has the detail; without a screen, what waits). The scripted
 * model says the same (`written`), so a parked turn reads alike whether or not the run suspended.
 */
export function parkedLine(
  approval: ParkedApproval | null | undefined,
  turn?: Partial<TurnVoice>,
): string {
  const lang = turn?.lang ?? 'en';
  const summary = approval?.summary ?? t(lang, 'said.aChange');
  // Absent (a run stored before it was kept) reads as the person's own.
  const team = approval?.canDecide === false;
  if (turn?.spoken) {
    // "It's on screen" only where there is one; otherwise what waits.
    const screen = (turn.surfaces ?? []).some((s) => s === 'inline' || s === 'canvas');
    if (screen) return t(lang, team ? 'said.teamOnScreen' : 'said.needsApproval');
    return t(lang, team ? 'said.waitingTeam' : 'said.waitingApproval', { summary });
  }
  return t(lang, team ? 'said.askedTeam' : 'said.askedYou', { summary });
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
