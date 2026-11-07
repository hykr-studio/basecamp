import {
  type DocumentInfo,
  type FormField,
  formAsksCustom,
  formFieldsOf,
  listInputSchema,
  maskAddress,
  type PageSpec,
  type Principal,
  publicForms,
  ShareCapabilities,
  type Shared,
  type SharedBlock,
  type SharedForm,
  type SharedPage,
  type SharedRecord,
  type ShareKinds,
  type ShareLinkInfo,
  shareables,
  summaryInputSchema,
} from '@hykr/contracts';
import {
  type AnyEntityDef,
  type ChildEntityDef,
  CORE_OPTIONS,
  type CoreOptions,
  entityDef,
  type ShareLinkRow,
  summarize,
  TenantConfigService,
  tenantMoney,
} from '@hykr/core';
import { customFields, type Database, documents, shareLinks } from '@hykr/db';
import { can } from '@hykr/policy';
import {
  ForbiddenException,
  HttpException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { and, desc, eq, sql } from 'drizzle-orm';
import { ZodError } from 'zod';
import { runtime } from '../../runtime.js';
import { acceptanceOf } from '../acceptance/define.js';
import { DocumentsService } from '../documents/documents.service.js';
import { infoOf } from './ops.js';

type Values = Record<string, unknown>;

/** At most this many rows of each child entity on a share page. */
const CHILD_ROWS = 500;

const noSuch = (message = 'This is no longer shared') =>
  new NotFoundException({ error: 'not_found', message });

/** A custom field type a form can ask, by the business's field type. */
const CUSTOM_TYPES: Readonly<Record<string, FormField['type']>> = {
  text: 'text',
  number: 'number',
  boolean: 'boolean',
  date: 'date',
  select: 'select',
};

/** What a link may name, as asked in `GET /api/shares`. */
export type ShareQuery = { entity?: string; id?: string; page?: string; form?: string };

/**
 * Reading share links (decisions B9): the shareables and forms declared, a target's links for the
 * team, and what a guest sees through one, read with the guest's own principal everywhere (its
 * grant, the field policy and every read projector).
 */
@Injectable()
export class ShareService {
  private readonly db: Database;

  constructor(
    @Inject(CORE_OPTIONS) core: CoreOptions,
    @Inject(TenantConfigService) private readonly tenants: TenantConfigService,
    @Inject(ModuleRef) private readonly ref: ModuleRef,
  ) {
    this.db = core.db;
  }

  private get documentsService(): DocumentsService {
    return this.ref.get(DocumentsService, { strict: false });
  }

  /** What may be shared here: the shareable entities and the public forms. */
  kinds(): ShareKinds {
    return {
      entities: shareables.all().map((s) => ({
        entity: s.entity,
        children: [...(s.children ?? [])],
        documents: [...(s.documents ?? [])],
        acceptances: !!s.acceptances,
        pages: s.pages !== false,
        otp: s.otp ?? 'optional',
      })),
      forms: publicForms.all().map((f) => ({
        name: f.name,
        entity: f.entity,
        label: { ...f.label },
        otp: f.otp ?? 'optional',
      })),
    };
  }

  /**
   * A target's links, newest first, for someone who may share and reaches the target (a record,
   * a page of theirs, a declared form): 404 otherwise, never a hint the target exists.
   */
  async list(p: Principal, q: ShareQuery): Promise<ShareLinkInfo[]> {
    if (!p.tenantId) throw noSuch('No such business');
    if (!can(p, ShareCapabilities.create))
      throw new ForbiddenException({
        error: 'forbidden',
        rule: 'shares_create',
        reason: 'You cannot share by link here',
      });
    const links = shareLinks;
    let where: ReturnType<typeof and>;
    if (q.form) {
      if (!publicForms.has(q.form)) throw noSuch('No such form');
      where = and(eq(links.kind, 'form'), eq(links.form, q.form));
    } else {
      const entity = q.page ? 'page' : q.entity;
      const id = q.page ?? q.id;
      const def = entity ? entityDef(entity) : undefined;
      if (!def || !id || !(await def.repo.find(this.db, p, id))) throw noSuch('No such record');
      where = and(eq(links.resourceType, def.name), eq(links.resourceId, id));
    }
    const rows = await this.db
      .select()
      .from(links)
      .where(and(eq(links.tenantId, p.tenantId), where))
      .orderBy(desc(links.createdAt))
      .limit(200);
    return rows.map(infoOf);
  }

  /* ── What a guest sees ───────────────────────────────────────────────────── */

  /**
   * The link's page in one answer: what it is, the business's branding, its gate, and (once its
   * code is entered, or when it asks none) its content. Each answer with content counts a view.
   */
  async shared(link: ShareLinkRow, p: Principal, verified: boolean): Promise<Shared> {
    const { name, settings } = await this.tenants.get(link.tenantId);
    const out: Shared = {
      link: {
        id: link.id,
        kind: link.kind,
        label: link.label,
        expiresAt: link.expiresAt.toISOString(),
      },
      business: {
        name: settings.branding.name ?? name,
        logoUrl: settings.branding.logoUrl,
        colors: settings.branding.colors,
      },
      gate:
        link.otpChannel && link.otpAddress
          ? { channel: link.otpChannel, sentTo: maskAddress(link.otpAddress), verified }
          : null,
    };
    if (link.otpChannel && !verified) return out;
    if (link.kind === 'record') out.record = await this.record(link, p);
    else if (link.kind === 'page') out.page = await this.page(link, p);
    else out.form = await this.form(link);
    await this.db
      .update(shareLinks)
      .set({ views: sql`${shareLinks.views} + 1`, lastViewedAt: new Date() })
      .where(eq(shareLinks.id, link.id));
    return out;
  }

  /** The shared record as the guest reaches it: its view, value, children and made PDFs. */
  private async record(link: ShareLinkRow, p: Principal): Promise<SharedRecord> {
    const shareable = link.resourceType ? shareables.get(link.resourceType) : undefined;
    const def = shareable ? entityDef(shareable.entity) : undefined;
    const id = link.resourceId ?? '';
    const row = def ? await def.repo.find(this.db, p, id) : undefined;
    if (!shareable || !def || !row) throw noSuch();
    const asked = shareable.view ?? def.spec.views?.item ?? null;
    const view = asked && runtime().registry.getViewDef(asked) ? asked : null;
    const children: SharedRecord['children'] = [];
    for (const name of shareable.children ?? []) {
      const child = entityDef(name) as (AnyEntityDef & Partial<ChildEntityDef>) | undefined;
      if (!child?.children) continue;
      const rows = await child.children.list(this.db, p, id);
      children.push({
        entity: child.name,
        items: rows.slice(0, CHILD_ROWS).map((r) => child.toRead(r, p) as Values),
        truncated: rows.length > CHILD_ROWS,
      });
    }
    const names = shareable.documents ?? [];
    const docs = names.length ? await this.documentsService.list(p, def.name, id) : [];
    return {
      entity: def.name,
      id,
      view,
      value: def.toRead(row, p) as Values,
      children,
      documents: docs
        .filter((d) => d.status === 'ready' && names.includes(d.document))
        .map((d) => ({
          id: d.id,
          document: d.document,
          name: d.name ?? d.document,
          version: d.version,
          acceptable: !!shareable.acceptances && !!acceptanceOf(d.document),
        })),
    };
  }

  /**
   * A shared page: its blocks as its maker sees them, without their capabilities (the guest's
   * principal, `reach: 'sharer'`). Only blocks with a data source over a shareable entity whose
   * lists may be shown; a block that fails (a filter on a hidden field) is left out.
   */
  private async page(link: ShareLinkRow, p: Principal): Promise<SharedPage> {
    const pageDef = entityDef('page');
    const row = pageDef ? await pageDef.repo.find(this.db, p, link.resourceId ?? '') : undefined;
    if (!pageDef || !row) throw noSuch();
    const saved = pageDef.toRead(row, p) as { id: string; name: string; spec: PageSpec };
    const registry = runtime().registry;
    const blocks: SharedBlock[] = [];
    for (const b of saved.spec.blocks) {
      const source = registry.getViewDef(b.view)?.source;
      const def = source ? entityDef(source.entity.name) : undefined;
      const shareable = def ? shareables.get(def.name) : undefined;
      if (!source || !def || !shareable || shareable.pages === false) continue;
      try {
        const data = await this.blockData(def, source.by, b, p);
        if (!data) continue;
        blocks.push({
          id: b.id,
          view: b.view,
          ...(b.query ? { query: b.query } : {}),
          ...(b.props ? { props: b.props } : {}),
          ...(b.span ? { span: b.span } : {}),
          data,
        });
      } catch (e) {
        if (e instanceof HttpException || e instanceof ZodError) continue;
        throw e;
      }
    }
    return { id: saved.id, name: saved.name, layout: saved.spec.layout, blocks };
  }

  private async blockData(
    def: AnyEntityDef,
    by: 'query' | 'id' | 'summary',
    b: PageSpec['blocks'][number],
    p: Principal,
  ): Promise<SharedBlock['data'] | undefined> {
    if (by === 'id') {
      const id = b.props?.id;
      const row = typeof id === 'string' ? await def.repo.find(this.db, p, id) : undefined;
      return row ? { record: def.toRead(row, p) } : undefined;
    }
    if (by === 'summary') {
      const q = summaryInputSchema(def.spec).parse(b.query ?? {});
      return { summary: await summarize(this.db, def, p, q) };
    }
    const q = listInputSchema(def.spec, { maxLimit: def.spec.list.pageSize.max }).parse(
      b.query ?? {},
    );
    // As a list request would: a filter or sort on a field the guest cannot see is refused.
    for (const x of def.plugins()) x.query?.(q, p, { spec: def.spec, table: def.table });
    const page = await def.repo.list(this.db, p, q);
    return { items: page.items.map((r) => def.toRead(r, p)) };
  }

  /** A form link's questions: the application's fields, then the business's own. */
  private async form(link: ShareLinkRow): Promise<SharedForm> {
    const form = link.form ? publicForms.get(link.form) : undefined;
    const def = form ? entityDef(form.entity) : undefined;
    if (!form || !def) throw noSuch();
    const fields = formFieldsOf(def.spec, form);
    if (formAsksCustom(def.spec, form)) {
      const own = await this.db
        .select()
        .from(customFields)
        .where(and(eq(customFields.tenantId, link.tenantId), eq(customFields.entity, def.name)))
        .orderBy(customFields.position, customFields.createdAt);
      for (const f of own) {
        const type = CUSTOM_TYPES[f.type];
        if (!type) continue;
        const label = f.label as { en: string; hi?: string; te?: string };
        fields.push({
          key: f.key,
          type,
          label: { en: label.en, hi: label.hi ?? label.en, te: label.te ?? label.en },
          required: f.required,
          ...(type === 'select' ? { options: [...((f.options as string[] | null) ?? [])] } : {}),
          custom: true,
        });
      }
    }
    return {
      name: form.name,
      entity: def.name,
      label: { ...form.label },
      description: form.description ? { ...form.description } : null,
      fields,
      currency: (await tenantMoney(this.db, link.tenantId)).currency,
      remaining: link.maxUses === null ? null : Math.max(0, link.maxUses - link.uses),
    };
  }

  /**
   * One of the shared record's declared PDFs, made, with a short-lived download URL (the
   * documents service's own reach for the guest). Any other document: 404.
   */
  async document(link: ShareLinkRow, p: Principal, documentId: string): Promise<DocumentInfo> {
    await this.declaredDocument(link, documentId);
    const info = await this.documentsService.get(p, documentId);
    // The file is what a guest came for: who else it was sent to is not theirs to see.
    return { ...info, sends: [] };
  }

  /**
   * A document of the link's record that its shareable declares (and may be accepted here, when
   * `acceptable`): 404 otherwise.
   */
  async declaredDocument(
    link: ShareLinkRow,
    documentId: string,
    opts: { acceptable?: boolean } = {},
  ): Promise<void> {
    const shareable =
      link.kind === 'record' && link.resourceType ? shareables.get(link.resourceType) : undefined;
    const [doc] = await this.db
      .select({
        name: documents.name,
        resourceType: documents.resourceType,
        resourceId: documents.resourceId,
      })
      .from(documents)
      .where(and(eq(documents.id, documentId), eq(documents.tenantId, link.tenantId)));
    const ok =
      !!shareable &&
      !!doc &&
      doc.resourceType === link.resourceType &&
      doc.resourceId === link.resourceId &&
      (shareable.documents ?? []).includes(doc.name) &&
      (!opts.acceptable || (!!shareable.acceptances && !!acceptanceOf(doc.name)));
    if (!ok) throw new NotFoundException({ error: 'not_found', message: 'No such document' });
  }
}
