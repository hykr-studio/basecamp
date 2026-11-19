// The images a document shows (docs/decisions/B21.md): `load` picks them with `ctx.image`, as the
// person who asks (a file they may open, on a record they reach, in a field they still see), the
// worker reads their bytes from storage and checks them against the SHA-256 taken then. Nothing
// here fetches a web address.
import { createHash } from 'node:crypto';
import { baseMime, type Principal } from '@hykr/contracts';
import type { Conn, Tx } from '@hykr/core';
import { files } from '@hykr/db';
import { Logger, UnprocessableEntityException } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import type { FilesService } from '../files/files.service.js';
import { sniff } from '../files/sniff.js';
import type { ImageLimits } from './config.js';
import { type CheckedLayout, type ImageRef, imageRefsOf } from './layout.js';

const log = new Logger('DocumentImages');

/** The types a document draws. Others (SVG, WebP, HEIC, GIF, AVIF) are refused. */
const DRAWN = new Set(['image/png', 'image/jpeg']);

/** What the documents feature needs of the files feature: set when the API or worker starts. */
let filesOf: (() => FilesService) | undefined;

/** Called by DocumentsService when the application starts. */
export function setDocumentFiles(get: () => FilesService) {
  filesOf = get;
}

function files_(): FilesService {
  if (!filesOf) throw new Error('The documents feature has not started (no files service)');
  return filesOf();
}

/** A named failure of a request for a document, answered 422 (never a 500). */
export const unprocessable = (error: string, message: string, extra: object = {}) =>
  new UnprocessableEntityException({ error, message, ...extra });

/**
 * The images one `load` is given: each checked once, the bytes counted against the document's
 * limit. `given` is what the layout may name.
 */
export class ImagePicker {
  readonly given = new Map<string, ImageRef>();
  private readonly refused = new Set<string>();
  private total = 0;

  constructor(
    private readonly tx: Tx,
    private readonly p: Principal,
    private readonly limits: ImageLimits,
  ) {}

  /** The image of this file, or null when p may not open it or it cannot be drawn. */
  async image(fileId: string): Promise<ImageRef | null> {
    if (typeof fileId !== 'string' || !fileId) return null;
    const had = this.given.get(fileId);
    if (had) return had;
    if (this.refused.has(fileId)) return null;
    const ref = await this.pick(fileId);
    if (ref) this.given.set(fileId, ref);
    else this.refused.add(fileId);
    return ref;
  }

  /** The images of these files that p may open, in their order; the others are left out. */
  async images(fileIds: readonly string[]): Promise<ImageRef[]> {
    const out: ImageRef[] = [];
    for (const id of fileIds ?? []) {
      const ref = await this.image(id);
      if (ref) out.push(ref);
    }
    return out;
  }

  private refuse(fileId: string, why: string): null {
    log.log(`file ${fileId} is not shown in a document: ${why}`);
    return null;
  }

  private async pick(fileId: string): Promise<ImageRef | null> {
    const { tx, p, limits } = this;
    if (!p.tenantId) return null;
    const [row] = await tx
      .select()
      .from(files)
      .where(and(eq(files.id, fileId), eq(files.tenantId, p.tenantId)));
    const service = files_();
    // As GET /api/files/:id would: the same business, on a record p reaches, in a field p sees.
    if (row?.status !== 'ready' || !(await service.reaches(p, row, undefined, tx))) return null;
    const declared = baseMime(row.mime);
    if (!DRAWN.has(declared)) return this.refuse(fileId, `${declared} is not drawn (PNG or JPEG)`);
    if (row.size > limits.maxBytes)
      return this.refuse(fileId, `image_too_large: ${row.size} bytes (at most ${limits.maxBytes})`);
    if (row.width && row.height && row.width * row.height > limits.maxPixels)
      return this.refuse(fileId, `image_too_large: ${row.width}×${row.height} pixels`);
    if (this.total + row.size > limits.maxTotalBytes)
      throw unprocessable(
        'images_too_large',
        `This document's images are more than ${limits.maxTotalBytes} bytes together`,
      );
    const bytes = await service.bytesOf(row);
    if (bytes.length > limits.maxBytes)
      return this.refuse(fileId, `image_too_large: ${bytes.length} bytes`);
    const found = sniff(bytes);
    if (!found.mime || found.mime !== declared || !found.width || !found.height)
      return this.refuse(fileId, `its bytes are not a ${declared} (${found.mime ?? 'unknown'})`);
    if (found.width * found.height > limits.maxPixels)
      return this.refuse(fileId, `image_too_large: ${found.width}×${found.height} pixels`);
    this.total += bytes.length;
    if (this.total > limits.maxTotalBytes)
      throw unprocessable(
        'images_too_large',
        `This document's images are more than ${limits.maxTotalBytes} bytes together`,
      );
    return {
      kind: 'image',
      fileId,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      mime: found.mime as ImageRef['mime'],
      width: found.width,
      height: found.height,
    };
  }
}

/**
 * The images a checked layout shows, each one `load` was given (same file, same SHA-256), and
 * no more of them than the limit. Returns them once each, for the snapshot.
 */
export function checkLayoutImages(
  layout: CheckedLayout,
  given: ReadonlyMap<string, ImageRef>,
  limits: ImageLimits,
): ImageRef[] {
  const used = imageRefsOf(layout);
  if (used.length > limits.maxCount)
    throw unprocessable(
      'too_many_images',
      `This document shows ${used.length} images (at most ${limits.maxCount})`,
    );
  const out = new Map<string, ImageRef>();
  for (const { ref, path } of used) {
    const had = given.get(ref.fileId);
    if (!had || had.sha256 !== ref.sha256)
      throw unprocessable(
        'image_not_loaded',
        `The layout shows an image its load was not given (at ${path.join('.')})`,
        { path },
      );
    out.set(had.fileId, had);
  }
  return [...out.values()];
}

/** A document's image could not be read as it was when asked for: the render fails at once. */
export class ImageUnavailable extends Error {
  constructor(readonly fileId: string) {
    super(`image_unavailable: ${fileId}`);
  }
}

/**
 * The bytes of a document's images, by file id, read through the storage driver in the worker
 * and checked against their SHA-256. A file erased, swept or changed since: ImageUnavailable.
 */
export async function imageBytes(
  conn: Conn,
  tenantId: string,
  refs: readonly ImageRef[],
): Promise<Map<string, Buffer>> {
  const out = new Map<string, Buffer>();
  if (!refs.length) return out;
  const service = files_();
  for (const ref of refs) {
    const [row] = await conn
      .select()
      .from(files)
      .where(and(eq(files.id, ref.fileId), eq(files.tenantId, tenantId)));
    if (row?.status !== 'ready') throw new ImageUnavailable(ref.fileId);
    let bytes: Buffer;
    try {
      bytes = await service.bytesOf(row);
    } catch {
      throw new ImageUnavailable(ref.fileId);
    }
    if (createHash('sha256').update(bytes).digest('hex') !== ref.sha256)
      throw new ImageUnavailable(ref.fileId);
    out.set(ref.fileId, bytes);
  }
  return out;
}
