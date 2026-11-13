import { capabilities, statesOf, transitionNamed, versionedOf } from '@hykr/contracts';
import { entityDef } from '@hykr/core';
import { Injectable, type OnModuleInit } from '@nestjs/common';
import { documents } from '../documents/define.js';
import { acceptances } from './define.js';
import { esignProviders } from './esign.js';

/**
 * At start: every acceptance names a declared document of a served, versioned entity (a PDF
 * is bound to the record's version), at most one acceptance per document, a transition that
 * exists and only the server runs (`expose: 'system'`: nobody moves the record without
 * accepting), a capability someone declares, and a registered e-sign provider.
 */
@Injectable()
export class AcceptanceStart implements OnModuleInit {
  onModuleInit() {
    const problems: string[] = [];
    const byDocument = new Map<string, string>();
    for (const def of acceptances.all()) {
      const fail = (why: string) => problems.push(`${def.name}: ${why}`);
      const taken = byDocument.get(def.document);
      if (taken) fail(`the document ${def.document} is already accepted by ${taken}`);
      byDocument.set(def.document, def.name);
      const doc = documents.get(def.document);
      if (!doc) {
        fail(`no document "${def.document}" is declared`);
        continue;
      }
      const entity = entityDef(doc.entity);
      if (!entity) {
        fail(`the entity "${doc.entity}" is not served`);
        continue;
      }
      if (!versionedOf(entity.spec))
        fail(`${entity.name} has no versions (traits.versioned): an acceptance binds a version`);
      if (def.transition) {
        const machine = statesOf(entity.spec);
        const t = machine && transitionNamed(machine, def.transition);
        if (!t) fail(`${entity.name} has no transition "${def.transition}"`);
        else if (t.expose !== 'system')
          fail(`its transition "${t.name}" must be expose: 'system' (only an acceptance runs it)`);
      }
      if (typeof def.by === 'object' && !capabilities.has(def.by.capability))
        fail(`nobody declares the capability "${def.by.capability}"`);
      if (def.esign && !esignProviders.has(def.esign))
        fail(`no e-sign provider "${def.esign}" is registered`);
    }
    if (problems.length) throw new Error(`Acceptances:\n- ${problems.join('\n- ')}`);
  }
}
