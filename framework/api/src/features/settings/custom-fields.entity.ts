// The business's custom field definitions (A11) as a framework entity: /api/custom-fields. Every
// member reads them (they label the records everyone sees); `settings.manage` changes them.
import { CustomFieldSpec, customFieldTypes, SettingsCapability } from '@hykr/contracts';
import { defineEntity, deny, entityDef, hasCustomFields } from '@hykr/core';
import { schema } from '@hykr/db';
import { type Access, can } from '@hykr/policy';

/** The framework's member roles read and write every definition of the business. */
const TEAM: Access['read'] = { owner: 'tenant', admin: 'tenant', ops: 'tenant', staff: 'tenant' };

export const CustomFieldDef = defineEntity(CustomFieldSpec, {
  table: schema.customFields,
  owner: (t) => t.ownerId,
  access: { read: TEAM, write: TEAM },
  rules: [
    // Only someone who manages the business's settings changes its fields.
    (p) =>
      can(p, SettingsCapability)
        ? null
        : deny(
            'needs_settings_manage',
            "Only someone who manages the business's settings can change its fields",
          ),
    // A known type, on an entity that takes custom fields; a list of options exactly for a select.
    (_p, action, row, input) => {
      if (action === 'delete') return null;
      const type = String(input?.type ?? row?.type ?? '');
      const def = customFieldTypes.get(type);
      if (action === 'create') {
        if (!def) return deny('unknown_field_type', `There is no custom field type "${type}"`);
        const entity = entityDef(String(input?.entity ?? ''));
        if (!entity || !hasCustomFields(entity.spec))
          return deny('no_custom_fields', `${String(input?.entity)} takes no custom fields`);
      }
      const options = (input?.options ?? (action === 'create' ? undefined : row?.options)) as
        | string[]
        | undefined;
      if (def?.needsOptions && !options?.length)
        return deny('needs_options', `A ${type} field needs its options`);
      if (!def?.needsOptions && input?.options !== undefined && (input.options as string[]).length)
        return deny('no_options', `A ${type} field takes no options`);
      if (options && new Set(options).size !== options.length)
        return deny('options_twice', 'An option is listed twice');
      return null;
    },
  ],
  summarize: (action, input, row) =>
    `${action === 'create' ? 'Add' : action === 'update' ? 'Change' : 'Remove'} the custom field ${String(input?.key ?? row?.key)}`,
});
