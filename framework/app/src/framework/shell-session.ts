// Who the shell shows (B12): the server's answer to "who is signed in", or, when the app opens
// without a network, the last person signed in on this device, until the network is back and the
// session can be checked again. Whenever the person shown changes (to another person, or to the
// sign-in screen), every answer the app holds in memory is dropped first. The next person then
// never sees what the last one read, and the offline plugin never saves it under their name.
// Pure, so it is tested without React Native. docs/decisions/B12.md, decision 17.
import { isNetworkError } from '@hykr/api-client';
import type { SessionUser } from '../session';

/** undefined while the session loads, null for the sign-in screen. */
export type Shown = SessionUser | null | undefined;

export type ShellSessionDeps = {
  /** Ask the server who is signed in: null for nobody; a throw when it could not answer. */
  me(): Promise<SessionUser | null>;
  /** Draw the shell for this person (null: the sign-in screen). */
  render(user: SessionUser | null): void;
  /** Drop every answer the app holds in memory: the query client's `clear`. */
  clear(): void;
  /** The last person signed in on this device, for a start without a network. */
  last(): SessionUser | null;
  remember(user: SessionUser): void;
  forget(): void;
  /** Calls the listener when the network comes and goes; returns its unsubscribe. */
  onNetwork(listener: (online: boolean) => void): () => void;
};

export interface ShellSession {
  /** Who the shell shows now. */
  shown(): Shown;
  /**
   * Check the session now. A check that could not reach the server opens on the last person
   * here, and checks again when the network is back. Returns the stop.
   */
  start(): () => void;
  /** Someone signed in on the sign-in screen. */
  signedIn(user: SessionUser): void;
  /** The person shown signed out. */
  signedOut(): void;
}

export function createShellSession(deps: ShellSessionDeps): ShellSession {
  let shown: Shown;
  const show = (user: SessionUser | null) => {
    // Someone else, or nobody: what the last person read goes before anything is drawn.
    if (shown && shown.id !== user?.id) deps.clear();
    shown = user;
    deps.render(user);
  };
  return {
    shown: () => shown,
    start() {
      let stopped = false;
      // Opened on the last session for want of a network: check again once it is back.
      let unchecked = false;
      const check = () =>
        deps
          .me()
          .then((user) => {
            if (stopped) return;
            unchecked = false;
            if (user) deps.remember(user);
            else deps.forget();
            show(user);
          })
          .catch((e) => {
            if (stopped) return;
            if (isNetworkError(e)) {
              unchecked = true;
              if (shown === undefined) show(deps.last());
              return;
            }
            deps.forget();
            show(null);
          });
      void check();
      const unsubscribe = deps.onNetwork((online) => {
        if (online && unchecked) void check();
      });
      return () => {
        stopped = true;
        unsubscribe();
      };
    },
    signedIn(user) {
      deps.remember(user);
      show(user);
    },
    signedOut() {
      deps.forget();
      deps.clear();
      shown = null;
      deps.render(null);
    },
  };
}
