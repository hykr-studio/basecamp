import { CreatedBy, entitySpec, fileRefs } from '@hykr/contracts';
import { z } from 'zod';

const title = z.string().min(1).max(200);
const body = z.string().max(20_000);
/** Photos kept on the note: uploaded in the app, or sent on WhatsApp. */
const photos = fileRefs(10);

export const NoteView = z.object({
  id: z.string(),
  title,
  body,
  meetingId: z.string().nullable(),
  photos,
  createdBy: CreatedBy,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type NoteView = z.infer<typeof NoteView>;

export const CreateNoteInput = z.object({
  title,
  body: body.default(''),
  meetingId: z.uuid().optional(),
  photos: photos.optional(),
});
export type CreateNoteInput = z.input<typeof CreateNoteInput>;

export const UpdateNoteInput = z
  .object({
    title: title.optional(),
    body: body.optional(),
    meetingId: z.uuid().nullable().optional(),
    photos: photos.optional(),
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
    photos: { en: 'Photos', hi: 'फ़ोटो', te: 'ఫోటోలు' },
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
  // Up to ten images of 10 MB each; SVG is not an image here. Notes are memory too: the
  // assistant recalls them by meaning, as memory of their meeting, for whoever may read both
  // (the framework loads each again as the reader). A note about a customer is that customer's
  // personal data: it goes when they ask to be forgotten, and two years after its last change.
  traits: {
    files: { photos: { accept: ['image/*'], maxBytes: 10 * 1024 * 1024, max: 10 } },
    memory: {
      text: (n: NoteView) => [n.title, n.body?.trim()].filter(Boolean).join(': '),
      about: (n: NoteView) => (n.meetingId ? { type: 'meeting', id: n.meetingId } : null),
    },
    privacy: {
      subject: { customer: ['customerId'] },
      fields: ['title', 'body', 'photos'],
      erase: 'delete',
      retention: { name: 'notes.personal', days: 730, from: 'updatedAt', action: 'delete' },
      purpose: {
        en: 'Notes the team keeps about a customer and their meetings',
        hi: 'ग्राहक और उनकी मीटिंग के बारे में टीम के नोट',
        te: 'కస్టమర్ గురించి, వారి మీటింగ్‌ల గురించి బృందం ఉంచే నోట్స్',
      },
    },
  },
});
