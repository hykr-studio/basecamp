import { createHash } from 'node:crypto';
import {
  capabilities as capabilityRegistry,
  type DocumentInfo,
  type DocumentKindInfo,
  type Principal,
} from '@hykr/contracts';
import {
  CORE_OPTIONS,
  type CoreOptions,
  entityDef,
  projectRead,
  recordEvents,
  systemPrincipal,
} from '@hykr/core';
import { type Database, documentSends, documents, files, messages, writeAudit } from '@hykr/db';
import { langOf } from '@hykr/i18n';
import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { and, desc, eq, inArray } from 'drizzle-orm';
import type { Jobs } from '../../hooks.js';
import { JOBS } from '../../queues/define.js';
import { runtime } from '../../runtime.js';
import { FilesService } from '../files/files.service.js';
import {
  DOCUMENT_FILE,
  DocumentEvent,
  type DocumentRow,
  eventRowOf,
  infoOf,
  reachable,
  reaches,
  sendInfoOf,
} from './access.js';
import { layoutOf, type Snapshot } from './commands.js';
import { channelsOf, documents as documentDefs } from './define.js';
import { DOCUMENT_ENGINE, type DocumentEngine } from './engine/index.js';

const log = new Logger('Documents');

/** The queues' names (defined in index.ts, which imports this file). */
export const RENDER_QUEUE = 'documents.render';
export const SEND_QUEUE = 'documents.send';

/**
 * BullMQ job ids (no ':'): one per document to draw; per send, one when it is asked for and one
 * when its document is made (a waiting send's first job has finished, and BullMQ keeps finished
 * jobs: the same id would add nothing).
 */
export const renderJobId = (id: string) => `render-${id}`;
export const sendJobId = (id: string, when: 'asked' | 'made' = 'asked') => `send-${when}-${id}`;

/** A failure's message, short enough to keep. */
const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 500);

/**
 * Documents: reading them (through their record, as their requester saw it) and drawing them in
 * the worker. Asking for one and asking to send one are commands (commands.ts), through the write
 * path; sending is the worker's DocumentSender (sender.ts). Nothing here loads the channel's
 * configuration, so `@hykr/api`'s entry can export it.
 */
@Injectable()
export class DocumentsService implements OnApplicationBootstrap {
  private readonly db: Database;

  constructor(
    @Inject(CORE_OPTIONS) core: CoreOptions,
    @Inject(DOCUMENT_ENGINE) readonly engine: DocumentEngine,
    @Inject(JOBS) private readonly jobs: Jobs,
    @Inject(ModuleRef) private readonly ref: ModuleRef,
  ) {
    this.db = core.db;
  }

  /** Another feature's or the channel's service, looked up when first used. */
  private service<T>(token: new (...args: never[]) => T): T {
    return this.ref.get(token, { strict: false });
  }

  /**
   * Every declared document is checked when the API or the worker starts: its entity is served,
   * the capabilities it names exist, and its WhatsApp template is one of the application's.
   */
  onApplicationBootstrap() {
    const problems: string[] = [];
    const templates = new Set(runtime().notifications.templates);
    for (const def of documentDefs.all()) {
      if (!entityDef(def.entity)) problems.push(`${def.name}: no entity "${def.entity}" is served`);
      for (const c of def.capabilities ?? [])
        if (!capabilityRegistry.has(c)) problems.push(`${def.name}: no capability "${c}"`);
      const template = def.send?.whatsapp?.template;
      if (template && !templates.has(template))
        problems.push(
          `${def.name}: its template ${template.name} is not one of the application's templates (add it to the module's templates)`,
        );
    }
    if (problems.length)
      throw new Error(`Documents are declared wrong:\n- ${problems.join('\n- ')}`);
  }

  /* ── Reading ─────────────────────────────────────────────────────────────── */

  /** A document as p may see it: the read projectors, resource type 'document'. */
  private project(info: DocumentInfo, p: Principal): DocumentInfo {
    return projectRead(
      'document',
      info as unknown as Record<string, unknown>,
      p,
    ) as unknown as DocumentInfo;
  }

  /** One document, with its sends and (for people, once made) a short-lived URL. */
  async get(p: Principal, id: string): Promise<DocumentInfo> {
    const { row } = await reachable(this.db, p, id);
    const sends = await this.db
      .select({ send: documentSends, messageStatus: messages.status })
      .from(documentSends)
      .leftJoin(messages, eq(messages.id, documentSends.messageId))
      .where(eq(documentSends.documentId, row.id))
      .orderBy(desc(documentSends.createdAt));
    const info: DocumentInfo = {
      ...this.project(infoOf(row), p),
      sends: sends.map((s) =>
        sendInfoOf(s.send, s.send.channel === 'whatsapp' ? s.messageStatus : null),
      ),
    };
    if (row.status !== 'ready' || !row.fileId || p.actor.kind === 'agent') return info;
    const [file] = await this.db.select().from(files).where(eq(files.id, row.fileId));
    if (!file) return info;
    const files_ = this.service(FilesService);
    return {
      ...info,
      url: await files_.urlFor(file),
      urlExpiresAt: new Date(Date.now() + files_.config.urlTtlS * 1000).toISOString(),
    };
  }

  /** A record's documents the caller reaches, newest first (the others are left out). */
  async list(p: Principal, entity: string, recordId: string): Promise<DocumentInfo[]> {
    if (!p.tenantId) return [];
    const rows = await this.db
      .select()
      .from(documents)
      .where(
        and(
          eq(documents.tenantId, p.tenantId),
          eq(documents.resourceType, entity),
          eq(documents.resourceId, recordId),
        ),
      )
      .orderBy(desc(documents.createdAt), desc(documents.version))
      .limit(100);
    const seen = new Map<string, boolean>();
    const out: DocumentInfo[] = [];
    for (const row of rows)
      if (await reaches(this.db, p, row, seen)) out.push(this.project(infoOf(row), p));
    return out;
  }

  /** The documents declared for an entity (all of them when none is named). */
  kinds(entity?: string): DocumentKindInfo[] {
    return documentDefs
      .all()
      .filter((d) => !entity || d.entity === entity)
      .map((d) => ({
        name: d.name,
        entity: d.entity,
        label: { ...d.label },
        channels: channelsOf(d),
      }));
  }

  /* ── Drawing (the documents.render queue) ────────────────────────────────── */

  /**
   * Draw a pending document from its stored data, store the PDF through the files feature, and
   * make it ready; its waiting sends go. On the last try, a failure makes it failed instead.
   */
  async render(documentId: string, lastTry: boolean): Promise<string> {
    const [doc] = await this.db.select().from(documents).where(eq(documents.id, documentId));
    if (doc?.status !== 'pending') return 'not pending';
    const def = documentDefs.get(doc.name);
    try {
      if (!def) throw new Error(`No document "${doc.name}" is declared`);
      const { business, value } = doc.data as Snapshot;
      const lang = langOf(doc.lang);
      const layout = layoutOf(def, value, lang, business);
      const out = await this.engine.render(layout, {
        lang,
        author: business.name,
        createdAt: doc.createdAt,
      });
      const file = await this.service(FilesService).storeBytes({
        tenantId: doc.tenantId,
        uploader: { kind: 'server' },
        source: 'server',
        name: doc.fileName,
        mime: this.engine.mime,
        bytes: out.bytes,
        audit: { actorKind: 'system', actorId: 'documents.render', channel: 'background' },
      });
      const sha256 = createHash('sha256').update(out.bytes).digest('hex');
      const queued = await this.db.transaction(async (tx) => {
        const [ready] = await tx
          .update(documents)
          .set({
            status: 'ready',
            fileId: file.id,
            size: out.bytes.length,
            pages: out.pages,
            sha256,
            renderedAt: new Date(),
            error: null,
          })
          .where(and(eq(documents.id, doc.id), eq(documents.status, 'pending')))
          .returning();
        // Another try made it meanwhile: this file is let go of (swept later).
        if (!ready) {
          await tx
            .update(files)
            .set({ status: 'detached', detachedAt: new Date() })
            .where(eq(files.id, file.id));
          return [];
        }
        await tx
          .update(files)
          .set({ ...DOCUMENT_FILE, resourceId: doc.id, attachedAt: new Date() })
          .where(eq(files.id, file.id));
        await this.audit(tx, ready, 'document.rendered', 'documents.render', {
          version: ready.version,
          size: ready.size,
          pages: ready.pages,
          sha256,
        });
        await recordEvents(tx, {
          principal: systemPrincipal({ tenantId: doc.tenantId, job: 'documents.render' }),
          events: [new DocumentEvent('document.rendered', eventRowOf(ready))],
        });
        return tx
          .update(documentSends)
          .set({ status: 'queued' })
          .where(and(eq(documentSends.documentId, doc.id), eq(documentSends.status, 'waiting')))
          .returning({ id: documentSends.id });
      });
      for (const s of queued) await this.queueSend(s.id, 'made');
      return 'ready';
    } catch (e) {
      if (!lastTry) throw e;
      log.error(`${doc.name} ${doc.id} could not be made: ${messageOf(e)}`);
      await this.db.transaction(async (tx) => {
        const [failed] = await tx
          .update(documents)
          .set({ status: 'failed', error: messageOf(e) })
          .where(and(eq(documents.id, doc.id), eq(documents.status, 'pending')))
          .returning();
        if (!failed) return;
        await this.audit(tx, failed, 'document.failed', 'documents.render', {
          error: failed.error,
        });
        await recordEvents(tx, {
          principal: systemPrincipal({ tenantId: doc.tenantId, job: 'documents.render' }),
          events: [new DocumentEvent('document.failed', eventRowOf(failed))],
        });
        await tx
          .update(documentSends)
          .set({ status: 'failed', error: 'document_failed' })
          .where(
            and(
              eq(documentSends.documentId, doc.id),
              inArray(documentSends.status, ['waiting', 'queued']),
            ),
          );
      });
      return 'failed';
    }
  }

  queueRender(documentId: string) {
    return this.jobs.add(RENDER_QUEUE, { documentId }, { jobId: renderJobId(documentId) });
  }

  queueSend(sendId: string, when: 'asked' | 'made' = 'asked') {
    return this.jobs.add(SEND_QUEUE, { sendId }, { jobId: sendJobId(sendId, when) });
  }

  audit(
    tx: Parameters<Parameters<Database['transaction']>[0]>[0],
    doc: DocumentRow,
    action: string,
    job: string,
    after: Record<string, unknown>,
  ) {
    return writeAudit(tx, {
      action,
      resourceType: 'document',
      resourceId: doc.id,
      actorKind: 'system',
      actorId: job,
      tenantId: doc.tenantId,
      channel: 'background',
      after: {
        document: doc.name,
        record: { entity: doc.resourceType, id: doc.resourceId },
        ...after,
      },
    });
  }
}
