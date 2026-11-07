// B9: a public form's questions, from the entity's create schema: their types, whether each is
// required, labels and choices; and what a form for an entity cannot ask.
import {
  CustomFieldsInput,
  definePublicForm,
  entitySpec,
  formAsksCustom,
  formFieldsOf,
  MoneyInput,
  publicFormProblems,
} from '@hykr/contracts';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

const same = (en: string) => ({ en, hi: en, te: en });

const Spec = entitySpec({
  name: 'unitBrief',
  label: 'brief',
  schemas: {
    read: z.object({ id: z.string() }),
    create: z.object({
      name: z.string().min(1).max(80),
      about: z.string().max(2000).optional(),
      size: z.number().int().min(1).max(9).optional(),
      ratio: z.number().optional(),
      when: z.iso.date().optional(),
      kind: z.enum(['a', 'b']).default('a'),
      urgent: z.boolean().optional(),
      budget: MoneyInput.optional(),
      tags: z.array(z.string()).optional(),
      custom: CustomFieldsInput.optional(),
    }),
    update: z.object({ name: z.string().optional() }),
  },
  fieldLabels: { name: same('Your name') },
  list: {
    filterable: {},
    sortable: ['name'],
    defaultSort: [['name', 'asc']],
    pageSize: { default: 10, max: 10 },
  },
  traits: { money: { fields: ['budget'] }, customFields: {} },
});

const form = (fields: string[], extra: object = {}) =>
  definePublicForm({
    name: 'unit.brief',
    entity: 'unitBrief',
    label: same('Brief'),
    fields,
    ...extra,
  });

describe('a public form', () => {
  it('asks each field as its type, in order, with its label', () => {
    const fields = formFieldsOf(
      Spec,
      form(['name', 'about', 'size', 'ratio', 'when', 'kind', 'urgent', 'budget']),
    );
    expect(fields).toEqual([
      { key: 'name', label: same('Your name'), required: true, type: 'text', max: 80 },
      { key: 'about', label: same('about'), required: false, type: 'longText', max: 2000 },
      { key: 'size', label: same('size'), required: false, type: 'integer', min: 1, max: 9 },
      { key: 'ratio', label: same('ratio'), required: false, type: 'number' },
      { key: 'when', label: same('when'), required: false, type: 'date' },
      { key: 'kind', label: same('kind'), required: false, type: 'select', options: ['a', 'b'] },
      { key: 'urgent', label: same('urgent'), required: false, type: 'boolean' },
      { key: 'budget', label: same('budget'), required: false, type: 'money' },
    ]);
    expect(formAsksCustom(Spec, form(['name']))).toBe(true);
    expect(formAsksCustom(Spec, form(['name'], { custom: false }))).toBe(false);
  });

  it('cannot ask a list, an unknown field, or leave a required one out', () => {
    expect(publicFormProblems(Spec, form(['name', 'tags']))).toEqual([
      'tags is not text, a number, yes or no, a date, a choice or an amount',
    ]);
    expect(publicFormProblems(Spec, form(['name', 'colour']))).toEqual([
      "colour is not a field of unitBrief's create schema",
    ]);
    expect(publicFormProblems(Spec, form(['about']))).toEqual([
      'name is required by unitBrief but neither asked nor fixed',
    ]);
    expect(publicFormProblems(Spec, form(['about'], { fixed: { name: 'Web' } }))).toEqual([]);
    expect(publicFormProblems(Spec, form(['name'], { customerName: 'about' }))).toEqual([
      'customerName about is not one of the fields asked',
    ]);
  });

  it('is named <module>.<form> and asks something', () => {
    expect(() => form(['name'], { name: 'Brief' })).toThrow(/<module>.<form>/);
    expect(() => form([], { custom: false })).toThrow(/asks nothing/);
  });
});
