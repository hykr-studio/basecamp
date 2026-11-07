/**
 * What the framework itself owns, in every domain: saved canvas pages, the business's memory,
 * sending a customer a template, handing a conversation to a person, and comments on records.
 */
import type { CommandSpec } from '../framework/spec.js';
import { AddCommentSpec, EditCommentSpec, RemoveCommentSpec } from './comment.js';
import { RequestHumanSpec } from './handoff.js';
import { MemorySpec } from './memory.js';
import { SendTemplateSpec } from './notify.js';
import { SavedPageSpec } from './page.js';

export * from './backoffice.js';
export * from './comment.js';
export * from './document.js';
export * from './file.js';
export * from './handoff.js';
export * from './imports.js';
export * from './job.js';
export * from './members.js';
export * from './memory.js';
export * from './notify.js';
export * from './page.js';

export const platformEntities = {
  pages: SavedPageSpec,
  memories: MemorySpec,
} as const;
export const platformCommands: readonly CommandSpec[] = [
  SendTemplateSpec,
  RequestHumanSpec,
  AddCommentSpec,
  EditCommentSpec,
  RemoveCommentSpec,
];
export * from './settings.js';
