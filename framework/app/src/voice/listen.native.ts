/**
 * On iOS and Android the voice worker does the listening (VOICE_MODE=live). Device speech
 * recognition here would need its own native module; until then a fake-mode session on a
 * phone answers typed lines only.
 */
export const canListen = () => false;
export type Listener = { stop(): void; pause(paused: boolean): void; setLang(tag: string): void };
export function listen(): Listener | undefined {
  return undefined;
}
