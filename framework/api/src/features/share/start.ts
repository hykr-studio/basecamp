import { publicFormProblems, publicForms, shareables } from '@hykr/contracts';
import { childLinkOf, entityDef } from '@hykr/core';
import { Injectable, type OnModuleInit } from '@nestjs/common';
import { runtime } from '../../runtime.js';
import { documents } from '../documents/define.js';

/**
 * At start (decisions B9, 3 and 16): every shareable names a served entity, its children are its
 * children, its documents are declared for it, its view is registered; every public form names a
 * served entity and asks only fields a form can ask, every required one asked or fixed.
 */
@Injectable()
export class ShareStart implements OnModuleInit {
  onModuleInit() {
    const problems: string[] = [];
    const registry = runtime().registry;
    for (const def of shareables.all()) {
      const fail = (why: string) => problems.push(`shareable ${def.entity}: ${why}`);
      const entity = entityDef(def.entity);
      if (!entity) {
        fail('the entity is not served');
        continue;
      }
      for (const child of def.children ?? []) {
        const link = childLinkOf(child);
        if (!link || link.parent.name !== entity.name)
          fail(`${child} is not a child entity of ${entity.name}`);
        else if (shareables.has(child)) fail(`${child} is shareable on its own as well`);
      }
      for (const name of def.documents ?? []) {
        const doc = documents.get(name);
        if (!doc) fail(`no document "${name}" is declared`);
        else if (doc.entity !== entity.name) fail(`the document ${name} is not of ${entity.name}`);
      }
      if (def.view && !registry.getViewDef(def.view)) fail(`no view "${def.view}" is registered`);
    }
    const children = shareables.all().flatMap((s) => s.children ?? []);
    for (const child of new Set(children))
      if (children.filter((c) => c === child).length > 1)
        problems.push(`shareables: ${child} comes with two shareables`);
    for (const def of publicForms.all()) {
      const entity = entityDef(def.entity);
      if (!entity) {
        problems.push(`public form ${def.name}: the entity ${def.entity} is not served`);
        continue;
      }
      for (const why of publicFormProblems(entity.spec, def))
        problems.push(`public form ${def.name}: ${why}`);
    }
    if (problems.length) throw new Error(`Share links:\n- ${problems.join('\n- ')}`);
  }
}
