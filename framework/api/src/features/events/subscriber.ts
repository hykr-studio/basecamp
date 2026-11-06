// Declaring subscribers. Nothing here reads the configuration or loads Nest: safe to import from
// an application module at load time.
import type { DomainEventEnvelope } from '@hykr/contracts';
import { queues, type Subscriber, subscribers } from '../../hooks.js';

/** The shared queue subscribers with `handle` run on. */
export const EVENTS_QUEUE = 'events';

const NAME = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;
/** 'task.created', 'task.*', '*'. */
const PATTERN = /^(?:\*|[a-z][a-zA-Z0-9_-]*(?:\.[a-zA-Z0-9_-]+)*(?:\.\*)?)$/;

/** Does an `on` entry match this event name? 'task.*' matches 'task.created', not 'tasks.x'. */
export function matchesEvent(pattern: string, name: string): boolean {
  if (pattern === '*') return true;
  if (pattern.endsWith('.*')) return name.startsWith(pattern.slice(0, -1));
  return pattern === name;
}

/** Does this subscriber want this event? */
export const wants = (s: Subscriber, event: DomainEventEnvelope) =>
  s.on.some((p) => matchesEvent(p, event.name)) && (s.when?.(event) ?? true);

/** One job per event and subscriber (BullMQ ids may not contain ':'). */
export const subscriberJobId = (subscriber: string, eventId: string) =>
  `${subscriber}--${eventId}`.replaceAll(':', '_');

/**
 * A subscriber, checked: its name, its patterns, and exactly one of `handle` and `queue`.
 * Contribute it (`contributes: { subscribers }`).
 *
 *   export const ResumeOnDecision = defineSubscriber({
 *     name: 'resume.approvals',
 *     on: ['approval.decided'],
 *     handle: async (event, ctx) => ctx.get(ResumeService).resume(event),
 *   });
 */
export function defineSubscriber(def: Subscriber): Subscriber {
  if (!NAME.test(def.name))
    throw new Error(
      `The subscriber name "${def.name}" must be lower case words joined by "." or "-"`,
    );
  if (!def.on.length) throw new Error(`Subscriber ${def.name}: name at least one event in on`);
  const bad = def.on.find((p) => !PATTERN.test(p));
  if (bad) throw new Error(`Subscriber ${def.name}: "${bad}" is not an event name or "<prefix>.*"`);
  if (!def.handle === !def.queue)
    throw new Error(`Subscriber ${def.name}: give exactly one of handle and queue`);
  if (def.queue === EVENTS_QUEUE)
    throw new Error(`Subscriber ${def.name}: give handle to run on the events queue`);
  return def;
}

/** Check every registered subscriber, as the start does: a `queue` must be registered. */
export function checkSubscribers() {
  for (const s of subscribers.all()) {
    defineSubscriber(s);
    if (s.queue && !queues.has(s.queue))
      throw new Error(`Subscriber ${s.name} sends to ${s.queue}, which is not a registered queue`);
  }
}
