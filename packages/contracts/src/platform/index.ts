/**
 * What the framework itself owns, in every domain: saved canvas pages, sending a customer a
 * template, and handing a conversation to a person.
 */
import type { CommandSpec } from '../framework/spec.js';
import { RequestHumanSpec } from './handoff.js';
import { SendTemplateSpec } from './notify.js';
import { SavedPageSpec } from './page.js';

export * from './backoffice.js';
export * from './handoff.js';
export * from './notify.js';
export * from './page.js';

export const platformEntities = { pages: SavedPageSpec } as const;
export const platformCommands: readonly CommandSpec[] = [SendTemplateSpec, RequestHumanSpec];
