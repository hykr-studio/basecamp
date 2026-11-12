// Keys someone sends (a query string's, a body's, a route's) may name what every plain object
// already has. Written into an object they reach its prototype; read from one they find a
// built-in instead of nothing (docs/decisions/V1.md).

/** Every name a plain object has before anything is put in it, and `prototype`. */
const PROTOTYPE_KEYS: ReadonlySet<string> = new Set([
  ...Object.getOwnPropertyNames(Object.prototype),
  'prototype',
]);

/** Is this a name a plain object already has (`__proto__`, `constructor`, `toString`, …)? */
export const isPrototypeKey = (key: string): boolean => PROTOTYPE_KEYS.has(key);

/** What the object holds under this key itself; never what its prototype gives. */
export const ownValue = (o: object, key: string): unknown =>
  Object.hasOwn(o, key) ? (o as Record<string, unknown>)[key] : undefined;
