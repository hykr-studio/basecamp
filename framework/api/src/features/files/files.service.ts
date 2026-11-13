import { createHash, randomUUID } from 'node:crypto';
import {
  acceptsMime,
  baseMime,
  type FileFieldPolicy,
  type FileInfo,
  type FileTranscript,
  fileIdsIn,
  type PresignFileInput,
  type PresignFileResult,
  type Principal,
  type Subject,
} from '@hykr/contracts';
import {
  type AnyEntityDef,
  auditCtx,
  CORE_OPTIONS,
  type CoreOptions,
  entityDef,
  entityDefs,
  findRepeat,
  projectRead,
  saveReply,
} from '@hykr/core';
import { type Database, type DbOrTx, files, writeAudit } from '@hykr/db';
import { subjectOf } from '@hykr/policy';
import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  type OnApplicationBootstrap,
  PayloadTooLargeException,
  ServiceUnavailableException,
  UnprocessableEntityException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { and, count, eq, gt, inArray, isNull, lt, or, type SQL, sql } from 'drizzle-orm';
import { assertFilesConfig, type FilesConfig, filesConfig } from './config.js';
import { fileFieldOf, fileFieldProblems, maxBytesOf } from './fields.js';
import { fileHolders } from './holders.js';
import { bytesFit, SNIFF_BYTES, sniff } from './sniff.js';
import { SPEECH, type Speech } from './speech.js';
import { STORAGE, type StorageDriver } from './storage/index.js';
import { type UploadTarget, uploadTargets } from './targets.js';

export type FileRow = typeof files.$inferSelect;

const log = new Logger('Files');

/** Types a browser may show inline: raster images, audio, video and PDF. Never SVG or HTML. */
const INLINE =
  /^(image\/(jpeg|png|gif|webp|avif|heic|heif)|audio\/[a-z0-9.+-]+|video\/[a-z0-9.+-]+|application\/pdf)$/;

/** A Content-Disposition for a stored file: inline when safe, else an attachment. */
export function dispositionOf(name: string, mime: string): string {
  const kind = INLINE.test(baseMime(mime)) ? 'inline' : 'attachment';
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/** Who sent or uploaded a file, as a principal's subject: a person, a contact, or the server. */
export type Uploader = Subject | { kind: 'server' };

/** Is this file the subject's own upload (a person's, a contact's, or the server's)? */
export function uploadedBy(row: Pick<FileRow, 'ownerId' | 'contactId' | 'source'>, p: Principal) {
  const s = subjectOf(p);
  if (s?.kind === 'user') return row.ownerId === s.userId;
  if (s?.kind === 'contact') return row.contactId === s.contactId;
  return p.actor.kind === 'system' && row.source === 'server' && !row.ownerId && !row.contactId;
}

/** A file's metadata, as the API shows it. */
export function infoOf(row: FileRow): FileInfo {
  return {
    id: row.id,
    name: row.name,
    mime: row.mime,
    size: row.size,
    status: row.status === 'pending' ? 'pending' : 'ready',
    source: row.source,
    width: row.width,
    height: row.height,
    transcript: row.transcript,
    transcriptLang: row.transcriptLang,
    attachedTo:
      row.resourceType && row.resourceId && row.field
        ? { entity: row.resourceType, id: row.resourceId, field: row.field }
        : null,
    createdAt: row.createdAt.toISOString(),
  };
}

/** Where a file's bytes are kept: the business and the file's own id, never user input. */
const keyOf = (tenantId: string, id: string) => `t/${tenantId}/${id}`;

const notFound = () => new NotFoundException({ error: 'not_found', message: 'No such file' });

const unavailable = () =>
  new ServiceUnavailableException({
    error: 'storage_unavailable',
    message: 'File storage is not available right now. Try again shortly.',
  });

/** A refusal with a stable rule, as the write path answers. */
const refused = (status: number, rule: string, reason: string) =>
  new HttpException({ error: 'forbidden', rule, reason }, status);

/** Who asks, and how to recognise their retry: the request's id and idempotency-key. */
export type FileWriteMeta = { requestId: string; idempotencyKey?: string };

/** What a presign's idempotency-key is kept under. */
const UPLOAD = { name: 'file.upload' };

/**
 * Files: uploads (presign, the bytes straight to storage, confirm), what a caller may reach of
 * them, files the server stores itself (WhatsApp media, documents), transcription of audio, and
 * the sweeper. Attaching a file to a record is the record's own write (attach.hook.ts).
 */
@Injectable()
export class FilesService implements OnApplicationBootstrap {
  readonly config: FilesConfig = filesConfig();

  private readonly db: Database;

  constructor(
    @Inject(CORE_OPTIONS) core: CoreOptions,
    @Inject(STORAGE) readonly storage: StorageDriver,
    @Inject(SPEECH) private readonly stt: Speech,
  ) {
    assertFilesConfig(this.config);
    this.db = core.db;
  }

  /**
   * At startup: every served entity's file fields are checked (a mistake stops the start), and
   * the bucket is created when it is missing (a store that is down only logs: file routes
   * answer 503 until it is back).
   */
  async onApplicationBootstrap() {
    const problems = entityDefs().flatMap(fileFieldProblems);
    for (const t of uploadTargets.all())
      if (entityDef(t.type)) problems.push(`The upload target "${t.type}" is named like an entity`);
    if (problems.length)
      throw new Error(`File fields are declared wrong:\n- ${problems.join('\n- ')}`);
    if (this.config.defaulted)
      log.warn('STORAGE_DRIVER is not set: files are kept in memory, in this process only');
    await this.ready().catch((e) =>
      log.error(
        `File storage (${this.storage.kind}) is not reachable: ${e instanceof Error ? e.message : e}`,
      ),
    );
  }

  private readyOnce?: Promise<void>;
  /** The store is ready (bucket created): once per process, again after a failure. */
  private ready(): Promise<void> {
    this.readyOnce ??= this.storage.ensureReady().catch((e) => {
      this.readyOnce = undefined;
      throw e;
    });
    return this.readyOnce;
  }

  /** Storage work: a store that is down, or failing, is a 503 the caller may retry. */
  private async store<T>(work: () => Promise<T>): Promise<T> {
    try {
      await this.ready();
      return await work();
    } catch (e) {
      log.error(`storage (${this.storage.kind}): ${e instanceof Error ? e.message : e}`);
      throw unavailable();
    }
  }

  private audit(
    tx: DbOrTx,
    p: Principal,
    requestId: string,
    action: string,
    row: FileRow,
    after: Record<string, unknown> = {},
  ) {
    return writeAudit(tx, {
      ...auditCtx(p, { rule: 'files', reason: action }, { principal: p, requestId }),
      action,
      resourceType: 'file',
      resourceId: row.id,
      after: { name: row.name, mime: row.mime, size: row.size, ...after },
    });
  }

  /* ── Upload ──────────────────────────────────────────────────────────────── */

  /** The served entity and file field an upload is for, or 400. */
  private target(
    entity: string,
    field: string,
  ): { label: string; policy: FileFieldPolicy; def?: AnyEntityDef; other?: UploadTarget } {
    const def = entityDef(entity);
    const policy = def ? fileFieldOf(def, field) : undefined;
    if (def && policy) return { label: def.spec.label, policy, def };
    // Not an entity: a target a feature registered (an import's file).
    const other = def ? undefined : uploadTargets.get(entity);
    if (other && other.field === field) return { label: other.type, policy: other, other };
    throw new BadRequestException({
      error: 'unknown_file_field',
      message: `"${entity}" has no file field "${field}"`,
    });
  }

  /**
   * Step one of an upload, for one entity's file field: the field's rules first (type, size),
   * then the person's reach (they may update that record now, or create one), then a pending
   * file and a URL to PUT its bytes to.
   */
  async presign(
    p: Principal,
    input: PresignFileInput,
    meta: FileWriteMeta,
  ): Promise<PresignFileResult> {
    const requestId = meta.requestId;
    const s = subjectOf(p);
    if (s?.kind !== 'user' || !p.tenantId)
      throw refused(403, 'needs_an_account', 'Sign in to upload');
    const { label, policy, def, other } = this.target(input.for.entity, input.for.field);
    const mime = baseMime(input.mime);
    if (!acceptsMime(policy, mime))
      throw new UnsupportedMediaTypeException({
        error: 'type_not_accepted',
        message: `${label} ${input.for.field} does not take ${mime} files`,
      });
    const cap = maxBytesOf(policy, this.config.maxBytes);
    if (input.size > cap)
      throw new PayloadTooLargeException({
        error: 'too_large',
        message: `The largest file here is ${cap} bytes`,
        maxBytes: cap,
      });
    // Their reach: the record they will put it on, or one they could create; for another
    // target, its own say.
    if (other) {
      if (input.for.id)
        throw new BadRequestException({
          error: 'unknown_file_field',
          message: `${label} takes no record id`,
        });
      const decision = other.may(p);
      if (decision.decision === 'deny') throw refused(403, decision.rule, decision.reason);
    } else if (!def) {
      throw notFound();
    } else if (input.for.id) {
      const row = await def.repo.find(this.db, p, input.for.id);
      if (!row)
        throw new NotFoundException({ error: 'not_found', message: `No such ${def.spec.label}` });
      const decision = def.decide(p, 'update', row, {});
      if (decision.decision === 'deny') throw refused(403, decision.rule, decision.reason);
    } else {
      const decision = def.decide(p, 'create', null, {});
      if (decision.decision === 'deny') throw refused(403, decision.rule, decision.reason);
    }
    // A retry with the same key is the same upload: a new URL for the file the first one made.
    const ctx = { principal: p, idempotencyKey: meta.idempotencyKey };
    const repeat = await findRepeat(this.db, ctx, UPLOAD, input);
    if (repeat) {
      const fileId = (repeat.result as { value?: { id?: string } }).value?.id ?? '';
      const again = await this.ownUpload(p, fileId);
      if (again.status !== 'pending')
        throw new ConflictException({
          error: 'already_uploaded',
          message: 'This upload was finished already',
        });
      // Its time to upload ran out: start again with a new key, as `confirm` says.
      const left = again.uploadExpiresAt
        ? Math.floor((again.uploadExpiresAt.getTime() - Date.now()) / 1000)
        : 0;
      if (left < 1)
        throw new ConflictException({
          error: 'upload_expired',
          message: 'The upload expired. Start again.',
        });
      return this.presigned(again, p, left);
    }
    const [{ n }] = await this.db
      .select({ n: count() })
      .from(files)
      .where(
        and(
          eq(files.ownerId, s.userId),
          eq(files.status, 'pending'),
          gt(files.createdAt, sql`now() - interval '1 day'`),
        ),
      );
    if (Number(n) >= this.config.maxPending)
      throw new HttpException(
        { error: 'too_many_uploads', message: 'Too many unfinished uploads. Try again later.' },
        HttpStatus.TOO_MANY_REQUESTS,
      );

    await this.ready().catch(() => {
      throw unavailable();
    });
    const id = randomUUID();
    const tenantId = p.tenantId;
    const row = await this.db.transaction(async (tx) => {
      const [created] = await tx
        .insert(files)
        .values({
          id,
          tenantId,
          ownerId: s.userId,
          source: 'upload',
          // The key is the server's own, never from the request.
          key: keyOf(tenantId, id),
          name: input.name,
          mime,
          size: input.size,
          status: 'pending',
          intendedType: def?.name ?? other?.type ?? input.for.entity,
          intendedField: input.for.field,
          uploadExpiresAt: new Date(Date.now() + this.config.uploadTtlS * 1000),
        })
        .returning();
      await this.audit(tx, p, requestId, 'file.upload', created, { for: input.for });
      // The file's id, never its signed URL: a repeat signs a new one.
      await saveReply(tx, ctx, UPLOAD, input, { status: 'done', value: { id: created.id } });
      return created;
    });
    return this.presigned(row, p, this.config.uploadTtlS);
  }

  /** Where to PUT a pending file's bytes, until its upload expires. */
  private async presigned(
    row: FileRow,
    p: Principal,
    expiresIn: number,
  ): Promise<PresignFileResult> {
    const upload = await this.store(() =>
      this.storage.presignPut(row.key, { mime: row.mime, size: row.size, expiresIn }),
    );
    return {
      file: this.project(infoOf(row), p),
      upload: {
        ...upload,
        method: 'PUT' as const,
        expiresAt: (row.uploadExpiresAt as Date).toISOString(),
      },
    };
  }

  /** The caller's own pending or unattached upload, or 404. */
  private async ownUpload(p: Principal, id: string): Promise<FileRow> {
    const [row] = await this.db
      .select()
      .from(files)
      .where(and(eq(files.id, id), eq(files.tenantId, p.tenantId ?? ''), isNull(files.resourceId)));
    if (!row || (row.status !== 'pending' && row.status !== 'ready') || !uploadedBy(row, p))
      throw notFound();
    return row;
  }

  /**
   * Step three: the bytes are there. Their size must be the size presigned, and an image or a
   * PDF must start like one; otherwise the object is deleted and the file stays pending (422).
   */
  async confirm(p: Principal, id: string, requestId: string): Promise<FileInfo> {
    const row = await this.ownUpload(p, id);
    if (row.status === 'ready') return this.withUrl(row, p);
    if (row.uploadExpiresAt && row.uploadExpiresAt < new Date())
      throw new ConflictException({
        error: 'upload_expired',
        message: 'The upload expired. Start again.',
      });
    const head = await this.store(() => this.storage.head(row.key));
    if (!head)
      throw new ConflictException({ error: 'not_uploaded', message: 'Nothing was uploaded yet' });
    const reject = async (error: string, message: string) => {
      await this.store(() => this.storage.delete(row.key));
      throw new UnprocessableEntityException({ error, message });
    };
    if (head.size !== row.size)
      return reject('size_mismatch', `Expected ${row.size} bytes, got ${head.size}`);
    const found = sniff(await this.store(() => this.storage.readStart(row.key, SNIFF_BYTES)));
    if (!bytesFit(row.mime, found))
      return reject('content_mismatch', `The file is not a ${row.mime} file`);
    const ready = await this.db.transaction(async (tx) => {
      const [updated] = await tx
        .update(files)
        .set({
          status: 'ready',
          confirmedAt: new Date(),
          width: found.width ?? null,
          height: found.height ?? null,
          uploadExpiresAt: null,
        })
        .where(and(eq(files.id, row.id), eq(files.status, 'pending')))
        .returning();
      if (!updated) throw new ConflictException({ error: 'already_confirmed' });
      await this.audit(tx, p, requestId, 'file.confirm', updated);
      return updated;
    });
    return this.withUrl(ready, p);
  }

  /**
   * An upload not on any record yet, thrown away by whoever uploaded it. A retry with the same
   * key answers as the first did.
   */
  async discard(p: Principal, id: string, meta: FileWriteMeta): Promise<void> {
    const ctx = { principal: p, idempotencyKey: meta.idempotencyKey };
    const op = { name: 'file.discard', args: { id } };
    if (await findRepeat(this.db, ctx, op, {})) return;
    const row = await this.ownUpload(p, id);
    await this.store(() => this.storage.delete(row.key));
    await this.db.transaction(async (tx) => {
      await tx.delete(files).where(and(eq(files.id, row.id), isNull(files.resourceId)));
      await this.audit(tx, p, meta.requestId, 'file.discard', row);
      await saveReply(tx, ctx, op, {}, { status: 'done', value: null });
    });
  }

  /* ── Reach ───────────────────────────────────────────────────────────────── */

  /**
   * Can p reach this file? Same business, always. On a record: p reaches the record (its
   * access, grants and plugins' scopes), an agent may read that entity, and the record as p
   * sees it still lists the file in that field (a hidden field hides its files). Not on a
   * record yet: only whoever uploaded it. Detached or erased: nobody.
   */
  async reaches(
    p: Principal,
    row: FileRow,
    /** Records already read for p in this request, by "type:id" (null: not reached). */
    seen = new Map<string, Record<string, unknown> | null>(),
  ): Promise<boolean> {
    if (!p.tenantId || row.tenantId !== p.tenantId) return false;
    if (row.status !== 'ready' && row.status !== 'pending') return false;
    if (!row.resourceType || !row.resourceId || !row.field) return uploadedBy(row, p);
    if (row.status !== 'ready') return false;
    const def = entityDef(row.resourceType);
    // Not an entity: a holder that keeps files (a job's results) answers, or nobody reaches it.
    if (!def)
      return (
        (await fileHolders.get(row.resourceType)?.reaches({
          p,
          resourceId: row.resourceId,
          field: row.field,
          fileId: row.id,
          db: this.db,
        })) ?? false
      );
    if (p.actor.kind === 'agent' && def.spec.expose.get !== 'all') return false;
    const key = `${def.name}:${row.resourceId}`;
    if (!seen.has(key)) {
      const record = await def.repo.find(this.db, p, row.resourceId);
      seen.set(key, record ? (def.toRead(record, p) as Record<string, unknown>) : null);
    }
    const record = seen.get(key);
    return !!record && fileIdsIn(record[row.field]).includes(row.id);
  }

  /** A file p reaches, or 404. */
  async reachable(p: Principal, id: string): Promise<FileRow> {
    const [row] = await this.db
      .select()
      .from(files)
      .where(and(eq(files.id, id), eq(files.tenantId, p.tenantId ?? '')));
    if (!row || !(await this.reaches(p, row))) throw notFound();
    return row;
  }

  /** Metadata as p may see it (read projectors, resource type 'file'). */
  private project(info: FileInfo, p: Principal): FileInfo {
    return projectRead(
      'file',
      info as unknown as Record<string, unknown>,
      p,
    ) as unknown as FileInfo;
  }

  /** Metadata, and a short-lived download URL for a ready file. Agents never get a URL. */
  private async withUrl(row: FileRow, p: Principal): Promise<FileInfo> {
    const info = infoOf(row);
    if (row.status !== 'ready' || p.actor.kind === 'agent') return this.project(info, p);
    const url = await this.urlFor(row);
    return this.project(
      {
        ...info,
        url,
        urlExpiresAt: new Date(Date.now() + this.config.urlTtlS * 1000).toISOString(),
      },
      p,
    );
  }

  /** A download URL for a stored file (server code: a document to send). */
  urlFor(row: Pick<FileRow, 'key' | 'name' | 'mime'>): Promise<string> {
    return this.store(() =>
      this.storage.presignGet(row.key, {
        mime: row.mime,
        disposition: dispositionOf(row.name, row.mime),
        expiresIn: this.config.urlTtlS,
      }),
    );
  }

  async get(p: Principal, id: string): Promise<FileInfo> {
    return this.withUrl(await this.reachable(p, id), p);
  }

  /** The files of these ids that p reaches; the others are left out, saying nothing of them. */
  async getMany(p: Principal, ids: readonly string[]): Promise<FileInfo[]> {
    const unique = [...new Set(ids)].slice(0, 100);
    if (!unique.length || !p.tenantId) return [];
    const rows = await this.db
      .select()
      .from(files)
      .where(and(inArray(files.id, unique), eq(files.tenantId, p.tenantId)));
    const seen = new Map<string, Record<string, unknown> | null>();
    const out: FileInfo[] = [];
    for (const id of unique) {
      const row = rows.find((r) => r.id === id);
      if (row && (await this.reaches(p, row, seen))) out.push(await this.withUrl(row, p));
    }
    return out;
  }

  /* ── Voice ───────────────────────────────────────────────────────────────── */

  /**
   * An audio file's words (speech to text), kept on the file: a second call returns them.
   * Anyone who reaches the file may ask, the assistant included.
   */
  async transcribe(p: Principal, id: string, requestId: string): Promise<FileTranscript> {
    const row = await this.reachable(p, id);
    if (row.status !== 'ready' || !baseMime(row.mime).startsWith('audio/'))
      throw new UnprocessableEntityException({
        error: 'not_audio',
        message: 'Only audio files have words',
      });
    if (row.transcript !== null) return { text: row.transcript, lang: row.transcriptLang };
    const bytes = await this.store(() => this.storage.read(row.key));
    let heard: { text: string; lang?: string };
    try {
      heard = await this.stt.transcribe(bytes, row.mime);
    } catch (e) {
      log.warn(`transcription failed: ${e instanceof Error ? e.message : e}`);
      throw new ServiceUnavailableException({
        error: 'not_transcribed',
        message: 'The words could not be made out. Try again later.',
      });
    }
    const lang = heard.lang ?? null;
    await this.db.transaction(async (tx) => {
      const [updated] = await tx
        .update(files)
        .set({ transcript: heard.text, transcriptLang: lang })
        .where(eq(files.id, row.id))
        .returning();
      await this.audit(tx, p, requestId, 'file.transcribe', updated, { lang });
    });
    return { text: heard.text, lang };
  }

  /* ── Server-side files ───────────────────────────────────────────────────── */

  /**
   * Store bytes the server has (a WhatsApp photo, a rendered document, a job's result) as a
   * ready file, not on any record yet: its uploader attaches it with a write. A file larger than
   * the deployment's cap is refused.
   */
  async storeBytes(a: {
    tenantId: string;
    uploader: Uploader;
    /** Also the person, when a contact's number is linked to an account. */
    ownerId?: string;
    source?: 'upload' | 'whatsapp' | 'server';
    name: string;
    mime: string;
    bytes: Buffer;
    /** Audited as this actor: a contact, a person, or the server's job. */
    audit?: {
      actorKind: 'user' | 'contact' | 'system' | 'agent';
      actorId: string;
      channel?: string;
    };
  }): Promise<FileRow> {
    if (a.bytes.length > this.config.maxBytes)
      throw new PayloadTooLargeException({ error: 'too_large', maxBytes: this.config.maxBytes });
    const mime = baseMime(a.mime);
    const found = sniff(a.bytes.subarray(0, SNIFF_BYTES));
    if (!bytesFit(mime, found))
      throw new UnprocessableEntityException({
        error: 'content_mismatch',
        message: `Not a ${mime} file`,
      });
    const ownerId = a.uploader.kind === 'user' ? a.uploader.userId : (a.ownerId ?? null);
    const contactId = a.uploader.kind === 'contact' ? a.uploader.contactId : null;
    const sha256 = createHash('sha256').update(a.bytes).digest('hex');
    const source = a.source ?? (a.uploader.kind === 'server' ? 'server' : 'upload');
    await this.ready().catch(() => {
      throw unavailable();
    });
    const id = randomUUID();
    const row = await this.db.transaction(async (tx) => {
      const [created] = await tx
        .insert(files)
        .values({
          id,
          tenantId: a.tenantId,
          ownerId,
          contactId,
          source,
          key: keyOf(a.tenantId, id),
          name: a.name.slice(0, 255) || 'file',
          mime,
          size: a.bytes.length,
          status: 'ready',
          width: found.width ?? null,
          height: found.height ?? null,
          sha256,
          confirmedAt: new Date(),
        })
        .returning();
      const actor = a.audit ?? {
        actorKind: a.uploader.kind === 'server' ? ('system' as const) : a.uploader.kind,
        actorId:
          a.uploader.kind === 'user'
            ? a.uploader.userId
            : a.uploader.kind === 'contact'
              ? a.uploader.contactId
              : 'files',
      };
      await writeAudit(tx, {
        ...actor,
        tenantId: a.tenantId,
        action: source === 'whatsapp' ? 'file.received' : 'file.stored',
        resourceType: 'file',
        resourceId: created.id,
        after: { name: created.name, mime, size: created.size, source },
      });
      return created;
    });
    try {
      await this.store(() => this.storage.put(row.key, a.bytes, mime));
    } catch (e) {
      await this.db.delete(files).where(eq(files.id, row.id));
      throw e;
    }
    return row;
  }

  /** A stored file's bytes, for server code that holds the row (a document to attach). */
  bytesOf(row: Pick<FileRow, 'key'>): Promise<Buffer> {
    return this.store(() => this.storage.read(row.key));
  }

  /* ── Sweeper ─────────────────────────────────────────────────────────────── */

  /**
   * Deletes what nobody can reach any more: uploads never confirmed (a day old), files never put
   * on a record and files taken off their record (after the grace period), and erased files (at
   * once). The rows go first, in
   * one transaction with their audit rows, then the objects: a file put back on its record
   * meanwhile is never half deleted, and an object whose delete fails is only logged (nothing
   * names it any more).
   */
  async sweep(batch = 200): Promise<{ deleted: number }> {
    const grace = sql`now() - make_interval(hours => ${this.config.detachedGraceH})`;
    const due: SQL = or(
      and(eq(files.status, 'pending'), lt(files.createdAt, sql`now() - interval '1 day'`)),
      and(eq(files.status, 'ready'), isNull(files.resourceId), lt(files.createdAt, grace)),
      and(eq(files.status, 'detached'), lt(files.detachedAt, grace)),
      eq(files.status, 'erased'),
    ) as SQL;
    let deleted = 0;
    for (;;) {
      const rows = await this.db.transaction(async (tx) => {
        const picked = await tx
          .select({ id: files.id })
          .from(files)
          .where(due)
          .limit(batch)
          .for('update', { skipLocked: true });
        if (!picked.length) return [];
        const gone = await tx
          .delete(files)
          .where(
            and(
              inArray(
                files.id,
                picked.map((r) => r.id),
              ),
              due,
            ),
          )
          .returning();
        for (const row of gone)
          await writeAudit(tx, {
            action: 'file.swept',
            resourceType: 'file',
            resourceId: row.id,
            actorKind: 'system',
            actorId: 'files.sweep',
            tenantId: row.tenantId,
            channel: 'background',
            reason: row.status,
          });
        return gone;
      });
      for (const row of rows)
        await this.store(() => this.storage.delete(row.key)).catch(() =>
          log.warn(`sweep: the object of ${row.id} could not be deleted`),
        );
      deleted += rows.length;
      if (rows.length < batch) break;
    }
    return { deleted };
  }
}
