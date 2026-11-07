// The assistant's turn, per business (A11): the tools of what the business switched off are taken
// away, and the business's custom fields are given as context, so the model can set and filter
// them.
import { CORE_OPTIONS, type CoreOptions, customFieldsOf, hasCustomFields } from '@hykr/core';
import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { type TurnGate, type TurnHook, type TurnInfo, turnHooks } from '../../hooks.js';
import { runtime } from '../../runtime.js';
import { entityOff, FeatureGates, toolsOff } from './gates.js';

@Injectable()
export class SettingsTurnHook implements TurnHook, OnModuleInit {
  readonly name = 'settings';

  constructor(
    private readonly gates: FeatureGates,
    @Inject(CORE_OPTIONS) private readonly options: CoreOptions,
  ) {}

  onModuleInit() {
    if (!turnHooks.has(this.name)) turnHooks.register(this);
  }

  async before(turn: TurnInfo): Promise<TurnGate | null> {
    const tenantId = turn.principal.tenantId;
    const catalog = runtime().catalog;
    const off = await this.gates.off(tenantId);
    const withoutTools = toolsOff(off, catalog);
    const context: string[] = [];
    if (tenantId)
      for (const spec of Object.values(catalog.entities)) {
        if (!hasCustomFields(spec) || entityOff(off, catalog, spec.name)) continue;
        const fields = await customFieldsOf(this.options.db, tenantId, spec.name);
        if (!fields.length) continue;
        const list = fields
          .map(
            (f) =>
              `${f.key} (${f.type}${f.type === 'select' ? `: ${f.options.join(', ')}` : ''}${f.required ? ', required' : ''}${f.filterable ? ', filterable' : ''})`,
          )
          .join('; ');
        context.push(
          `This business's ${spec.label} records have custom fields, set as "custom": { key: value } and filtered as custom: { key: value }: ${list}.`,
        );
      }
    if (!withoutTools.length && !context.length) return null;
    return { withoutTools, context };
  }
}
