// Custom fields (A11): fields a business adds to an entity at run time, kept in one jsonb column
// (`custom`), typed by the business's definitions and filterable in the list grammar. An entity
// opts in with the `customFields` trait, `custom` in its schemas and `custom: 'custom'` in
// `list.filterable`. The definitions are records of the framework's `customField` entity.
import { z } from 'zod';
import { Lang, LangCode, typedLabels } from '../languages.js';
import { isPrototypeKey, ownValue } from './keys.js';
import { defineListFieldType, type FieldValueContext } from './list.js';
import { PLATFORM_MODULE, stampModule } from './module.js';
import { createHookRegistry } from './registry.js';
import { entitySpec } from './spec.js';

declare module './traits.js' {
  interface EntityTraits {
    /** Businesses may add their own fields to it (its `custom` column). */
    customFields?: Record<string, never>;
  }
}
declare module './list.js' {
  interface ListFieldTypes {
    custom: true;
  }
}

/** The custom field types. Open: a feature adds one by declaration merging. */
export interface CustomFieldTypes {
  text: true;
  number: true;
  boolean: true;
  date: true;
  select: true;
}
export type CustomFieldType = keyof CustomFieldTypes & string;

/** What a type checks a value against: the field's definition. */
export interface CustomFieldTypeDef {
  name: CustomFieldType;
  /** One stored value of a field of this type. */
  value(field: { options: readonly string[] }): z.ZodType;
  /** Does a field of this type need a list of options? */
  needsOptions?: boolean;
}

/** Every custom field type. A name is defined once. */
export const customFieldTypes = createHookRegistry<CustomFieldTypeDef>(
  'custom field type',
  (t) => t.name,
);

/** Define a custom field type; businesses can use it from then on. */
export function defineCustomFieldType(type: CustomFieldTypeDef): CustomFieldTypeDef {
  customFieldTypes.register(type);
  return type;
}

for (const type of [
  { name: 'text', value: () => z.string().max(500) },
  { name: 'number', value: () => z.number().finite() },
  { name: 'boolean', value: () => z.boolean() },
  { name: 'date', value: () => z.iso.date() },
  {
    name: 'select',
    needsOptions: true,
    value: ({ options }) => z.string().refine((v) => options.includes(v), 'Not one of the options'),
  },
] satisfies CustomFieldTypeDef[])
  defineCustomFieldType(type);

/** The list operators; a key may not be one, so `custom[key]` never reads as an operator. */
const OPS = ['eq', 'ne', 'in', 'lt', 'lte', 'gt', 'gte', 'contains'] as const;

/**
 * A field's key: camelCase letters, at most 32 ('priority', 'roomCount'), so it also works in a
 * query string (`custom[priority]=high`). Never an operator's name, nor a name every object has
 * (`constructor`, `toString`): read from a record's values it would find a built-in.
 */
export const CUSTOM_KEY = /^[a-z][a-zA-Z]{0,31}$/;
export const CustomFieldKey = z
  .string()
  .regex(CUSTOM_KEY, 'A key is camelCase letters, at most 32')
  .refine(
    (k) => !(OPS as readonly string[]).includes(k) && !isPrototypeKey(k),
    'That key is reserved',
  );

/** One stored value. */
export const CustomFieldValue = z.union([z.string().max(500), z.number(), z.boolean()]);
export type CustomFieldValue = z.infer<typeof CustomFieldValue>;

/** A record's custom fields as read: key → value. Put it in the read schema as `custom`. */
export const CustomFieldValues = z.record(z.string(), CustomFieldValue);
export type CustomFieldValues = z.infer<typeof CustomFieldValues>;

/**
 * Custom fields in a create or update: key → value, or null to remove it. An update changes
 * only the keys it sends. Put it in the create and update schemas as `custom` (optional).
 */
export const CustomFieldsInput = z.record(CustomFieldKey, CustomFieldValue.nullable());
export type CustomFieldsInput = z.infer<typeof CustomFieldsInput>;

/**
 * A new record's `custom`, from the patches a form collected (null where a value was cleared):
 * the cleared keys left out, and undefined when nothing is left, so the create omits it.
 */
export function customForCreate(
  patch: Readonly<CustomFieldsInput> | null | undefined,
): CustomFieldValues | undefined {
  const values = Object.fromEntries(
    Object.entries(patch ?? {}).filter(
      (e): e is [string, CustomFieldValue] => e[1] !== null && e[1] !== undefined,
    ),
  );
  return Object.keys(values).length ? values : undefined;
}

/**
 * What a typed-in value of a field of this type sends: null when empty (it clears the value), a
 * number for a number field when the text is one, otherwise the text as typed, so the server
 * says what is wrong with it rather than the form dropping it.
 */
export function customValueFromText(type: string, text: string): CustomFieldValue | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (type === 'number' && /^[-+]?(\d+(\.\d*)?|\.\d+)$/.test(trimmed)) return Number(trimmed);
  return trimmed;
}

/**
 * A label in the business's languages, as a person writes it: English required, any of the
 * application's other languages optional (they fall back to it).
 */
export const FieldLabel = typedLabels(Lang, z.string().trim().min(1).max(60));
/** A field's label as read back: any language code (one no longer declared is never shown). */
const StoredFieldLabel = typedLabels(LangCode, z.string());

/** An entity's name, as entities are named ('todo'). */
const EntityName = z.string().regex(/^[a-z][a-zA-Z0-9]{0,63}$/);

/** A business's custom field on one entity. */
export const CustomField = z.object({
  id: z.string(),
  entity: z.string(),
  key: z.string(),
  type: z.string(),
  label: StoredFieldLabel,
  options: z.array(z.string()),
  required: z.boolean(),
  filterable: z.boolean(),
  position: z.number().int(),
  createdAt: z.iso.datetime(),
});
export type CustomField = z.infer<typeof CustomField>;

const Options = z.array(z.string().trim().min(1).max(60)).max(50);

export const CreateCustomFieldInput = z.object({
  entity: EntityName,
  key: CustomFieldKey,
  type: z.string().min(1).max(32),
  label: FieldLabel,
  options: Options.optional(),
  required: z.boolean().optional(),
  filterable: z.boolean().optional(),
  position: z.number().int().min(0).max(1000).optional(),
});

/** Key, type and entity never change: remove the field and add another. */
export const UpdateCustomFieldInput = z
  .object({
    label: FieldLabel.optional(),
    options: Options.optional(),
    required: z.boolean().optional(),
    filterable: z.boolean().optional(),
    position: z.number().int().min(0).max(1000).optional(),
  })
  .refine(
    (v) => Object.values(v).some((x) => x !== undefined),
    'Send at least one field to change',
  );

/** The framework's entity of custom field definitions: `/api/custom-fields`. */
export const CustomFieldSpec = entitySpec({
  name: 'customField',
  // A route segment is lower case with dashes: /api/custom-fields.
  plural: 'custom-fields',
  label: 'custom field',
  description:
    "The business's own fields on its records: a key, a type, a label and, for a list, its options.",
  schemas: { read: CustomField, create: CreateCustomFieldInput, update: UpdateCustomFieldInput },
  list: {
    filterable: { entity: 'text', key: 'text', filterable: 'boolean' },
    sortable: ['position', 'createdAt'],
    defaultSort: [
      ['position', 'asc'],
      ['createdAt', 'asc'],
    ],
    pageSize: { default: 100, max: 200 },
  },
  // A business's setup is changed by people, never by the assistant.
  expose: { list: 'all', get: 'all', create: 'human', update: 'human', delete: 'human' },
});
stampModule(CustomFieldSpec, PLATFORM_MODULE);

/**
 * Where a record's custom values are wrong, for the 400 ('priority: Not one of the options').
 * `checkRequired` on a create, and on an update that changes custom fields: a record made
 * before a field became required can still change its other fields.
 */
export function customValueProblems(
  fields: readonly Pick<CustomField, 'key' | 'type' | 'options' | 'required'>[],
  values: Readonly<Record<string, unknown>>,
  opts: { checkRequired: boolean },
): string[] {
  const problems: string[] = [];
  const byKey = new Map(fields.map((f) => [f.key, f]));
  for (const [key, value] of Object.entries(values)) {
    const field = byKey.get(key);
    if (!field) {
      problems.push(`${key}: no such custom field`);
      continue;
    }
    const type = customFieldTypes.get(field.type);
    if (!type) {
      problems.push(`${key}: the type ${field.type} is not defined here`);
      continue;
    }
    const parsed = type.value({ options: field.options }).safeParse(value);
    if (!parsed.success) problems.push(`${key}: ${parsed.error.issues[0]?.message ?? 'invalid'}`);
  }
  if (opts.checkRequired)
    for (const field of fields)
      if (field.required && [undefined, ''].includes(ownValue(values, field.key) as string))
        problems.push(`${field.key}: required`);
  return problems;
}

/** A filter on custom fields: key → value (eq), or key → { op: value }. */
const Scalar = z.union([z.string().max(200), z.number(), z.boolean()]);
const KeyFilter = z.union([
  Scalar,
  z
    .object({
      eq: Scalar.optional(),
      ne: Scalar.optional(),
      in: z.array(Scalar).min(1).max(100).optional(),
      lt: Scalar.optional(),
      lte: Scalar.optional(),
      gt: Scalar.optional(),
      gte: Scalar.optional(),
      contains: z.string().max(200).optional(),
    })
    .strict(),
]);
export const CustomFilter = z
  .record(CustomFieldKey, KeyFilter)
  .refine(
    (v) => Object.keys(v).length > 0 && Object.keys(v).length <= 10,
    'Filter on 1 to 10 custom fields',
  );
export type CustomFilter = z.infer<typeof CustomFilter>;

/**
 * The `custom` list field type. In JSON: `{ custom: { priority: 'high', estimate: { gte: 3 } } }`.
 * In a query string: `custom[priority]=high`, or the JSON itself, `custom={"estimate":{"gte":3}}`.
 */
defineListFieldType({
  name: 'custom',
  ops: ['eq'],
  value: ({ coerce }: FieldValueContext) =>
    coerce
      ? z.preprocess((v) => {
          if (typeof v !== 'string') return v;
          try {
            return JSON.parse(v);
          } catch {
            return v;
          }
        }, CustomFilter)
      : CustomFilter,
});
