import {
  publicFormProblems,
  publicForms,
  type ShareSendDef,
  shareables,
  sharePath,
} from '@hykr/contracts';
import { childLinkOf, entityDef, registerOp } from '@hykr/core';
import { Injectable, type OnModuleInit } from '@nestjs/common';
import { runtime } from '../../runtime.js';
import { documents } from '../documents/define.js';
import { createOp, reissueOp } from './ops.js';

/** Whose the share operations are in the approvals registry (a replay finds them). */
const OWNER = {};

/**
 * A declaration's WhatsApp template is one of the application's, and has a URL button that opens
 * the link: its path is `/share/{{1}}` (decisions B23), the token filling `{{1}}` when sent.
 */
function templateProblems(send: ShareSendDef | undefined, names: Set<string>): string[] {
  const template = send?.whatsapp?.template;
  if (!template) return [];
  const out: string[] = [];
  if (!names.has(template.name))
    out.push(
      `its template ${template.name} is not one of the application's templates (add it to the module's templates)`,
    );
  const url = sharePath('{{1}}');
  if (!(template.buttons ?? []).some((b) => b.type === 'url' && b.path === url))
    out.push(`its template ${template.name} has no URL button whose path is ${url}`);
  return out;
}

/**
 * At start (decisions B9, 3 and 16): every shareable names a served entity, its children are its
 * children, its documents are declared for it, its view is registered; every public form names a
 * served entity and asks only fields a form can ask, every required one asked or fixed. A
 * declaration that sends links names one of the application's templates, with a URL button to
 * the link (decisions B23). The share operations an approval replays are registered here.
 */
@Injectable()
export class ShareStart implements OnModuleInit {
  onModuleInit() {
    // An assistant's draft parks; its replay finds the operation by name.
    registerOp('share.create', (a) => createOp((a ?? {}) as { via?: 'draft' }), OWNER);
    registerOp(
      'share.reissue',
      (a) => reissueOp(String(a?.id ?? ''), (a ?? {}) as { via?: 'draft' }),
      OWNER,
    );
    const problems: string[] = [];
    const registry = runtime().registry;
    const templates = new Set(runtime().notifications.templates.map((t) => t.name));
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
      for (const why of templateProblems(def.send, templates)) fail(why);
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
      for (const why of templateProblems(def.send, templates))
        problems.push(`public form ${def.name}: ${why}`);
    }
    if (problems.length) throw new Error(`Share links:\n- ${problems.join('\n- ')}`);
  }
}
