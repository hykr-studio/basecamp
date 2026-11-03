import type { IconName } from './Icon';

/** A top-level destination: the rail on wide screens, the tab bar on phones. */
export type NavItem = {
  href: string;
  label: string;
  icon: IconName;
  match: (path: string) => boolean;
};

/** A message the assistant understands, offered in the thread ("What can it do?"). */
export type Suggestion = { text: string; what: string };

/**
 * What the app shell needs from an application. Its routes live in the application's own
 * src/app; its view and screen components are bound to the registry by `bind`, once at
 * startup. The framework's shell, thread and canvas read only this.
 */
export interface AppDomain {
  /** The product's name: the rail, the phone's top bar and the sign-in screen. */
  title: string;
  /** Under the product name in the rail: what this deployment is about. */
  tagline: string;
  /** The application's destinations, in order; the framework adds its own (Pages) after them. */
  nav: NavItem[];
  /** Where "not found" sends a person back to. The first destination when not set. */
  home?: { href: string; label: string };
  /** Messages to offer when the thread is empty or the person asks what it can do. */
  suggestions: Suggestion[];
  /** Bind this app's components to the application's registered views and screens. */
  bind: () => void;
}

export const defineAppDomain = (domain: AppDomain) => domain;
