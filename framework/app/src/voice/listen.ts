/**
 * Speech-to-text on the device, for when the voice worker cannot hear (fake mode, no speech
 * key): the browser's own recognition (Chrome, Edge, Safari). It runs while voice is on and
 * hands each finished phrase over to be answered as a spoken turn. Chrome sends the audio to
 * its own service to transcribe it: a development aid, not the product's speech path.
 */
type Recognition = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult:
    | ((e: {
        resultIndex: number;
        results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }>;
      }) => void)
    | null;
  onend: (() => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
};

const Ctor = (): (new () => Recognition) | undefined =>
  typeof window === 'undefined'
    ? undefined
    : (((window as unknown as Record<string, unknown>).SpeechRecognition ??
        (window as unknown as Record<string, unknown>).webkitSpeechRecognition) as
        | (new () => Recognition)
        | undefined);

export const canListen = () => Ctor() !== undefined;

export type Listener = { stop(): void; pause(paused: boolean): void; setLang(tag: string): void };

/**
 * Listen until stopped. `heard(text, final)` gets the words as they are recognised; a final
 * phrase is the turn. Recognition stops itself after a pause in speech, so it is restarted
 * for as long as the session runs (and not while paused, e.g. while the reply is read aloud).
 */
export function listen(
  lang: string,
  heard: (text: string, final: boolean) => void,
  failed: (error: string) => void,
): Listener | undefined {
  const Recognition = Ctor();
  if (!Recognition) return undefined;
  const r = new Recognition();
  r.continuous = true;
  r.interimResults = true;
  r.lang = lang;
  let on = true;
  let paused = false;
  let running = false;
  let restarts = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  // start() throws if it is already running: only ever call it from a stopped state.
  const begin = () => {
    if (!on || paused || running) return;
    try {
      r.start();
      running = true;
    } catch {
      // Still stopping: onend will try again.
    }
  };
  r.onresult = (e) => {
    restarts = 0;
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const result = e.results[i];
      const text = result[0].transcript.trim();
      if (text) heard(text, result.isFinal);
    }
  };
  r.onerror = (e) => {
    // Silence and our own abort are normal. No permission, no service: stop for good, once.
    if (e.error === 'no-speech' || e.error === 'aborted') return;
    if (FATAL.has(e.error)) on = false;
    failed(e.error);
  };
  r.onend = () => {
    running = false;
    if (!on || paused) return;
    // It stops itself after a pause in speech: start again, backing off if it keeps ending.
    restarts += 1;
    clearTimeout(timer);
    timer = setTimeout(begin, Math.min(250 * 2 ** (restarts - 1), 5000));
  };
  begin();
  return {
    stop() {
      on = false;
      clearTimeout(timer);
      r.abort();
    },
    pause(next) {
      if (next === paused) return;
      paused = next;
      if (paused) {
        clearTimeout(timer);
        r.abort();
      } else begin();
    },
    setLang(tag) {
      r.lang = tag;
      // Takes effect on the next start: end this one, and onend starts it in the new language.
      if (running) r.abort();
    },
  };
}

/** Errors that will not go away by trying again. */
const FATAL = new Set([
  'not-allowed',
  'service-not-allowed',
  'audio-capture',
  'language-not-supported',
]);
