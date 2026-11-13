import { baseMime } from '@hykr/contracts';
import { Controller, Get, Inject, Param, Put, Req, Res } from '@nestjs/common';
import { AllowAnonymous } from '@thallesp/nestjs-better-auth';
import type { Request, Response } from 'express';
import { TakesBytes } from '../../infra/untrusted-text.js';
import { filesConfig } from './config.js';
import {
  BLOB_PATH,
  type LocalDriver,
  STORAGE,
  type StorageDriver,
  verifyBlob,
} from './storage/index.js';

/** The bytes of a request: already read by a body parser (JSON), or read now, up to a cap. */
async function bodyOf(req: Request, cap: number): Promise<Buffer | null> {
  // The JSON body parser (on for every route, with rawBody) has read a JSON upload already and
  // kept its bytes; body-parser 2 sets no `_body` flag, so look at what it kept, and never read
  // a stream it ended.
  const parsed = req as Request & { rawBody?: Buffer };
  if (Buffer.isBuffer(parsed.rawBody)) return parsed.rawBody;
  if (req.readableEnded) return null;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > cap) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

const refuse = (res: Response, status: number, error: string) => res.status(status).json({ error });

/**
 * The local drivers' URLs (memory, fs): `/api/files/blob/<token>`, where the token is a signed
 * grant for one method on one key until it expires. No session: the token is the right, as with
 * a presigned S3 URL. A PUT must send the signed type and exactly the signed size; a GET is
 * served with the signed type and disposition, never sniffed, in a sandbox.
 */
@Controller(BLOB_PATH.slice(1))
@AllowAnonymous()
@TakesBytes()
export class BlobController {
  private readonly secret = filesConfig().secret;

  constructor(@Inject(STORAGE) private readonly storage: StorageDriver) {}

  private local(): LocalDriver | null {
    return this.storage.kind === 's3' ? null : (this.storage as LocalDriver);
  }

  @Get(':token')
  async get(@Param('token') token: string, @Res() res: Response) {
    const store = this.local();
    const grant = verifyBlob(this.secret, token);
    if (!store || !grant || grant.m !== 'GET') return refuse(res, 404, 'not_found');
    if (!(await store.head(grant.k))) return refuse(res, 404, 'not_found');
    const bytes = await store.read(grant.k);
    res
      .status(200)
      .set({
        'content-type': grant.t,
        'content-length': String(bytes.length),
        'content-disposition': grant.d ?? 'attachment',
        'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'none'; sandbox",
        'cache-control': `private, max-age=${Math.max(0, grant.e - Math.floor(Date.now() / 1000))}`,
      })
      .end(bytes);
  }

  @Put(':token')
  async put(@Param('token') token: string, @Req() req: Request, @Res() res: Response) {
    const store = this.local();
    const grant = verifyBlob(this.secret, token);
    if (!store || !grant || grant.m !== 'PUT' || grant.s === undefined)
      return refuse(res, 403, 'bad_upload_url');
    if (baseMime(req.headers['content-type'] ?? '') !== baseMime(grant.t))
      return refuse(res, 403, 'wrong_type');
    const length = req.headers['content-length'];
    if (length !== undefined && Number(length) !== grant.s) return refuse(res, 403, 'wrong_size');
    const bytes = await bodyOf(req, grant.s);
    if (!bytes || bytes.length !== grant.s) return refuse(res, 403, 'wrong_size');
    await store.accept(grant, bytes);
    res.status(200).end();
  }
}
