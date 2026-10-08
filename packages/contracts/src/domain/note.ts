import { z } from 'zod';
import { CreatedBy, entitySpec } from '../framework/spec.js';

const title = z.string().min(1).max(200);
const body = z.string().max(20_000);

export const NoteView = z.object({
  id: z.string(),
  title,
  body,
  meetingId: z.string().nullable(),
  createdBy: CreatedBy,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type NoteView = z.infer<typeof NoteView>;

export const CreateNoteInput = z.object({
  title,
  body: body.default(''),
  meetingId: z.uuid().optional(),
});
export type CreateNoteInput = z.input<typeof CreateNoteInput>;

export const UpdateNoteInput = z
  .object({
    title: title.optional(),
    body: body.optional(),
    meetingId: z.uuid().nullable().optional(),
  })
  .refine(
    (v) => Object.values(v).some((x) => x !== undefined),
    'Send at least one field to change',
  );
export type UpdateNoteInput = z.infer<typeof UpdateNoteInput>;

export const NoteSpec = entitySpec({
  name: 'note',
  label: 'note',
  description:
    'Markdown notes, optionally linked to a meeting (a closed meeting has a summary note).',
  schemas: { read: NoteView, create: CreateNoteInput, update: UpdateNoteInput },
  // What people call each field, in every language (approval cards, history, voice).
  fieldLabels: {
    title: { en: 'Title', hi: 'शीर्षक', te: 'శీర్షిక' },
    body: { en: 'Note', hi: 'नोट', te: 'నోట్' },
    meetingId: { en: 'Meeting', hi: 'मीटिंग', te: 'మీటింగ్' },
    createdBy: { en: 'Created by', hi: 'किसने बनाया', te: 'ఎవరు సృష్టించారు' },
  },
  list: {
    filterable: { meetingId: 'id', createdAt: 'date', title: 'text' },
    sortable: ['createdAt', 'updatedAt', 'title'],
    defaultSort: [['createdAt', 'desc']],
    search: ['title', 'body'],
    pageSize: { default: 25, max: 100 },
    examples: {
      meetingId: '"<meeting id>"',
      createdAt: '{ "gte": "2026-10-01" }',
      title: '{ "contains": "cement" }',
    },
  },
  approval: { delete: (p) => p.actor.kind === 'agent' },
  views: { list: 'note.list', item: 'note.card' },
});
