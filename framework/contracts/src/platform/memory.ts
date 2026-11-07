import { z } from 'zod';
import { CreatedBy, entitySpec } from '../framework/spec.js';
import { defineCapability } from '../roles.js';

const text = z.string().trim().min(1).max(2000);

/** One thing the business remembers: a lasting fact every member's assistant may recall. */
export const Memory = z.object({
  id: z.string(),
  text,
  createdBy: CreatedBy,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type Memory = z.infer<typeof Memory>;

export const CreateMemoryInput = z.object({ text });
export type CreateMemoryInput = z.input<typeof CreateMemoryInput>;

export const UpdateMemoryInput = z.object({ text });
export type UpdateMemoryInput = z.infer<typeof UpdateMemoryInput>;

/**
 * The business's memory: facts that hold for everyone in it. Memory of one record (a project, a
 * meeting) is an entity of the application's with the `memory` trait; this one has no record.
 * Recall finds both by meaning (`recall-memory`, `GET /api/memory/recall`).
 */
export const MemorySpec = entitySpec({
  name: 'memory',
  plural: 'memories',
  label: 'memory',
  description:
    "The business's memory: lasting facts everyone in the business shares (when it is open, how it works, what it never does). When the person asks you to remember something for the business, save it with create-memory. To find memories by meaning, use recall-memory.",
  schemas: { read: Memory, create: CreateMemoryInput, update: UpdateMemoryInput },
  fieldLabels: {
    text: { en: 'Memory', hi: 'याद', te: 'జ్ఞాపకం' },
    createdBy: { en: 'Created by', hi: 'किसने बनाया', te: 'ఎవరు సృష్టించారు' },
  },
  list: {
    filterable: { text: 'text', createdAt: 'date' },
    sortable: ['updatedAt', 'createdAt'],
    defaultSort: [['updatedAt', 'desc']],
    search: ['text'],
    pageSize: { default: 50, max: 100 },
    examples: { text: '{ "contains": "sunday" }', createdAt: '{ "gte": "2026-10-01" }' },
  },
  // The assistant may add a memory when asked; changing or forgetting one waits for the person.
  approval: {
    update: (p) => p.actor.kind === 'agent',
    delete: (p) => p.actor.kind === 'agent',
  },
  views: { list: 'memory.list' },
  traits: { memory: { text: (m: Memory) => m.text } },
});

const MEMBERS = ['owner', 'admin', 'ops', 'staff'];

/** Read the business's memory, and have it recalled in your turns. */
export const MemoryRead = defineCapability({
  name: 'memory.read',
  label: {
    en: "Read the business's memory",
    hi: 'व्यवसाय की यादें पढ़ें',
    te: 'వ్యాపార జ్ఞాపకాలు చదవండి',
  },
  roles: MEMBERS,
});

/** Add to the business's memory, and change or delete your own memories. */
export const MemoryWrite = defineCapability({
  name: 'memory.write',
  label: {
    en: "Add to the business's memory",
    hi: 'व्यवसाय की यादों में जोड़ें',
    te: 'వ్యాపార జ్ఞాపకాలకు జోడించండి',
  },
  roles: MEMBERS,
});

/** Change or delete anyone's memories. */
export const MemoryManage = defineCapability({
  name: 'memory.manage',
  label: {
    en: "Change or delete anyone's memories",
    hi: 'किसी की भी यादें बदलें या हटाएँ',
    te: 'ఎవరి జ్ఞాపకాలనైనా మార్చండి లేదా తొలగించండి',
  },
  roles: ['owner', 'admin'],
});

/** What recall finds: a record that is memory (an entity with the trait), or the person's words. */
export const RecallKind = z.enum(['record', 'message']);
export type RecallKind = z.infer<typeof RecallKind>;

/** `<entity name>:<id>`: the record whose memory to recall ('meeting:1f0c…'). */
export const RecallAbout = z
  .string()
  .regex(/^[a-zA-Z][a-zA-Z0-9_]*:[A-Za-z0-9_-]+$/, 'A record as <type>:<id>');

/** `GET /api/memory/recall`: what to recall, by meaning. */
export const RecallQuery = z
  .object({
    q: z.string().trim().min(1).max(1000),
    about: RecallAbout.optional(),
    limit: z.coerce.number().int().min(1).max(20).optional(),
    /** Comma-separated kinds; both by default. */
    kinds: z
      .string()
      .regex(/^(record|message)(,(record|message))*$/, 'record, message, or both')
      .optional(),
  })
  .strict();
export type RecallQuery = z.input<typeof RecallQuery>;

/** One recalled memory, as the caller may see it. */
export const RecallItem = z.object({
  kind: RecallKind,
  /** The entity's name ('memory', 'note'), or 'message' for something the person said. */
  type: z.string(),
  id: z.string(),
  /** The record it is memory of. */
  about: z.object({ type: z.string(), id: z.string() }).optional(),
  text: z.string(),
  /** How close it is to the question: cosine similarity, 0 to 1. */
  score: z.number(),
  /** When it was said (a message) or last changed (a record, when it says). */
  at: z.string().optional(),
});
export type RecallItem = z.infer<typeof RecallItem>;

/** The best matches first. `model`: the embedding model that searched, or null when none could. */
export const RecallResult = z.object({
  items: z.array(RecallItem),
  model: z.string().nullable(),
});
export type RecallResult = z.infer<typeof RecallResult>;
