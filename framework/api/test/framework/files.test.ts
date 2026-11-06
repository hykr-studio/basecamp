// The files feature's pieces, without booting (B1): what a field accepts, what bytes say they
// are, the local drivers' signed URLs, and the storage drivers themselves. The S3 driver runs
// against the local MinIO (`pnpm infra:up`) and is skipped when it is not reachable.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DeleteBucketCommand, S3Client } from '@aws-sdk/client-s3';
import {
  acceptsMime,
  entitySpec,
  FileRef,
  fileFieldsOf,
  fileIdsIn,
  fileRefs,
} from '@hykr/contracts';
import { afterAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { assertFilesConfig, filesConfig } from '../../dist/features/files/config.js';
import { dispositionOf } from '../../dist/features/files/files.service.js';
import { fileLine, sizeText } from '../../dist/features/files/lines.js';
import { bytesFit, sniff } from '../../dist/features/files/sniff.js';
import { localDriver, signBlob, verifyBlob } from '../../dist/features/files/storage/local.js';
import { s3Driver } from '../../dist/features/files/storage/s3.js';

const u32 = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
};
const PNG = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  u32(13),
  Buffer.from('IHDR'),
  u32(800),
  u32(600),
  Buffer.alloc(8),
]);
/** A JPEG: SOI, an APP0 segment, then a baseline frame of 1024 × 768. */
const JPEG = Buffer.from([
  0xff,
  0xd8,
  0xff,
  0xe0,
  0x00,
  0x10,
  ...Buffer.from('JFIF\0'),
  1,
  1,
  0,
  0,
  1,
  0,
  1,
  0,
  0,
  0xff,
  0xc0,
  0x00,
  0x11,
  0x08,
  0x03,
  0x00,
  0x04,
  0x00,
  0x03,
  1,
  0x22,
  0,
  2,
  0x11,
  1,
  3,
  0x11,
  1,
]);
const GIF = Buffer.concat([
  Buffer.from('GIF89a'),
  Buffer.from([0x40, 0x01, 0xf0, 0x00]),
  Buffer.alloc(6),
]);
/** WebP, lossless: 300 × 150. */
const WEBP = (() => {
  const b = Buffer.alloc(30);
  b.write('RIFF', 0);
  b.write('WEBP', 8);
  b.write('VP8L', 12);
  b[20] = 0x2f;
  b.writeUInt32LE(((150 - 1) << 14) | (300 - 1), 21);
  return b;
})();
const HEIC = Buffer.concat([u32(24), Buffer.from('ftypheic'), Buffer.alloc(12)]);

describe('file fields (contracts)', () => {
  it('a family takes its types but never SVG, which must be named', () => {
    expect(acceptsMime({ accept: ['image/*'] }, 'image/jpeg')).toBe(true);
    expect(acceptsMime({ accept: ['image/*'] }, 'IMAGE/PNG; q=1')).toBe(true);
    expect(acceptsMime({ accept: ['image/*'] }, 'image/svg+xml')).toBe(false);
    expect(acceptsMime({ accept: ['image/*', 'image/svg+xml'] }, 'image/svg+xml')).toBe(true);
    expect(acceptsMime({ accept: ['application/pdf'] }, 'application/pdfx')).toBe(false);
    expect(acceptsMime({ accept: ['*/*'] }, 'image/svg+xml')).toBe(false);
    expect(acceptsMime({}, 'text/html')).toBe(true);
  });

  it('ids come from one id, a list, or nothing; a spec lists its file fields in order', () => {
    expect(fileIdsIn('a')).toEqual(['a']);
    expect(fileIdsIn(['a', '', 3, 'b'])).toEqual(['a', 'b']);
    expect(fileIdsIn(null)).toEqual([]);
    const spec = entitySpec({
      name: 'thing',
      label: 'thing',
      description: 'A thing.',
      schemas: {
        read: z.object({ id: z.string(), cover: FileRef.nullable(), photos: fileRefs(2) }),
        create: z.object({ cover: FileRef.optional() }),
        update: z.object({}),
      },
      list: { filterable: {}, sortable: [], defaultSort: [], pageSize: { default: 1, max: 1 } },
      traits: { files: { cover: { accept: ['image/*'] }, photos: { max: 2 } } },
    });
    expect(fileFieldsOf(spec).map(([f]) => f)).toEqual(['cover', 'photos']);
    expect(fileRefs(2).safeParse([crypto.randomUUID(), crypto.randomUUID()]).success).toBe(true);
    expect(fileRefs(2).safeParse(['a', 'b', 'c']).success).toBe(false);
  });
});

describe('what bytes say they are', () => {
  it('reads the type and size of PNG, JPEG, GIF and WebP, and the type of HEIC and PDF', () => {
    expect(sniff(PNG)).toEqual({ mime: 'image/png', width: 800, height: 600 });
    expect(sniff(JPEG)).toEqual({ mime: 'image/jpeg', width: 1024, height: 768 });
    expect(sniff(GIF)).toEqual({ mime: 'image/gif', width: 320, height: 240 });
    expect(sniff(WEBP)).toEqual({ mime: 'image/webp', width: 300, height: 150 });
    expect(sniff(HEIC)).toEqual({ mime: 'image/heic' });
    expect(sniff(Buffer.from('%PDF-1.7\n'))).toEqual({ mime: 'application/pdf' });
    expect(sniff(Buffer.from('<svg/>'))).toEqual({});
  });

  it('a declared image or PDF must start like one; other types are not checked', () => {
    expect(bytesFit('image/png', sniff(PNG))).toBe(true);
    expect(bytesFit('image/jpg', sniff(JPEG))).toBe(true);
    expect(bytesFit('image/png', sniff(JPEG))).toBe(false);
    expect(bytesFit('image/jpeg', sniff(Buffer.from('<html>')))).toBe(false);
    expect(bytesFit('application/pdf', sniff(Buffer.from('MZ')))).toBe(false);
    expect(bytesFit('text/plain', sniff(Buffer.from('<html>')))).toBe(true);
  });

  it('serves raster images, audio, video and PDF inline; anything else, SVG included, as an attachment', () => {
    expect(dispositionOf('a.png', 'image/png')).toMatch(/^inline; filename="a.png"/);
    expect(dispositionOf('a.pdf', 'application/pdf')).toMatch(/^inline;/);
    expect(dispositionOf('a.svg', 'image/svg+xml')).toMatch(/^attachment;/);
    expect(dispositionOf('a.html', 'text/html')).toMatch(/^attachment;/);
    // Names are quoted safely, and kept in full as UTF-8.
    expect(dispositionOf('फोटो "1".jpg', 'image/jpeg')).toBe(
      `inline; filename="____ _1_.jpg"; filename*=UTF-8''${encodeURIComponent('फोटो "1".jpg')}`,
    );
  });

  it('tells the assistant a file in a line of data', () => {
    expect(sizeText(12_345)).toBe('12 KB');
    expect(sizeText(3_400_000)).toBe('3.2 MB');
    expect(fileLine({ id: 'f1', name: 'a.png', mime: 'image/png', size: 900 })).toBe(
      'A file came with this message: "a.png" (image/png, 900 B), file id f1. ' +
        "To keep it on a record, put this id in one of that record's file fields.",
    );
  });
});

describe('the local drivers', () => {
  const secret = 'x'.repeat(40);

  it('a signed grant is one method on one key until it expires; anything else is refused', () => {
    const e = Math.floor(Date.now() / 1000) + 60;
    const token = signBlob(secret, { k: 't/a/1', m: 'PUT', t: 'image/png', s: 10, e });
    expect(verifyBlob(secret, token)).toEqual({ k: 't/a/1', m: 'PUT', t: 'image/png', s: 10, e });
    expect(verifyBlob('y'.repeat(40), token)).toBeNull();
    const [body, sig] = token.split('.');
    const forged = Buffer.from(
      JSON.stringify({ k: 't/b/1', m: 'PUT', t: 'image/png', s: 10, e }),
    ).toString('base64url');
    expect(verifyBlob(secret, `${forged}.${sig}`)).toBeNull();
    expect(verifyBlob(secret, `${body}.${sig}.x`)).toBeNull();
    expect(verifyBlob(secret, 'garbage')).toBeNull();
    const old = signBlob(secret, { k: 't/a/1', m: 'GET', t: 'image/png', e: e - 120 });
    expect(verifyBlob(secret, old)).toBeNull();
  });

  it('memory and folder drivers keep, read, measure and delete objects', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'files-'));
    try {
      for (const driver of [
        localDriver({ kind: 'memory' }, secret),
        localDriver({ kind: 'fs', dir }, secret),
      ]) {
        await driver.ensureReady();
        expect(await driver.head('t/a/1')).toBeNull();
        await driver.put('t/a/1', PNG, 'image/png');
        expect(await driver.head('t/a/1')).toEqual({ size: PNG.length });
        expect((await driver.readStart('t/a/1', 8)).equals(PNG.subarray(0, 8))).toBe(true);
        expect((await driver.read('t/a/1')).equals(PNG)).toBe(true);
        const put = await driver.presignPut('t/a/2', { mime: 'image/png', size: 5, expiresIn: 60 });
        expect(put.url).toMatch(/^\/api\/files\/blob\//);
        expect(put.headers).toEqual({ 'content-type': 'image/png' });
        await driver.delete('t/a/1');
        await driver.delete('t/a/1');
        expect(await driver.head('t/a/1')).toBeNull();
      }
      // A key never leaves the folder.
      await expect(
        localDriver({ kind: 'fs', dir }, secret).put('../x', PNG, 'x/y'),
      ).rejects.toThrow(/Bad storage key/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('the configuration refuses memory in production and an fs driver without a folder', () => {
    const env = { BETTER_AUTH_SECRET: 's'.repeat(40) };
    expect(filesConfig(env)).toMatchObject({
      driver: 'memory',
      defaulted: true,
      maxBytes: 25 * 1024 * 1024,
    });
    expect(() => assertFilesConfig(filesConfig(env), { ...env, NODE_ENV: 'production' })).toThrow(
      /production/,
    );
    expect(() => assertFilesConfig(filesConfig({ ...env, STORAGE_DRIVER: 'fs' }), env)).toThrow(
      /STORAGE_DIR/,
    );
    expect(() => filesConfig({ STORAGE_DRIVER: 'ftp' })).toThrow(/s3, fs or memory/);
    // The URL secret is derived, and differs from the auth secret.
    expect(filesConfig(env).secret).not.toBe(env.BETTER_AUTH_SECRET);
  });
});

const endpoint = process.env.S3_TEST_ENDPOINT ?? 'http://localhost:9000';
const reachable = await fetch(`${endpoint}/minio/health/live`, {
  signal: AbortSignal.timeout(1000),
})
  .then((r) => r.ok)
  .catch(() => false);

describe.skipIf(!reachable)('the S3 driver (local MinIO)', () => {
  const bucket = `basecamp-test-${Date.now()}`;
  const creds = {
    accessKeyId: process.env.S3_TEST_ACCESS_KEY_ID ?? 'minioadmin',
    secretAccessKey: process.env.S3_TEST_SECRET_ACCESS_KEY ?? 'minioadmin',
  };
  const driver = s3Driver({
    endpoint,
    publicEndpoint: endpoint,
    region: 'us-east-1',
    bucket,
    ...creds,
  });

  afterAll(async () => {
    await driver.delete('t/a/1');
    await new S3Client({ endpoint, region: 'us-east-1', forcePathStyle: true, credentials: creds })
      .send(new DeleteBucketCommand({ Bucket: bucket }))
      .catch(() => {});
  });

  it('creates its bucket when missing, and a presigned PUT takes only the signed type and size', async () => {
    await driver.ensureReady();
    await driver.ensureReady();
    const { url, headers } = await driver.presignPut('t/a/1', {
      mime: 'image/png',
      size: PNG.length,
      expiresIn: 60,
    });
    const put = (type: string, body: Buffer) =>
      fetch(url, {
        method: 'PUT',
        headers: { ...headers, 'content-type': type },
        body: new Uint8Array(body),
      });
    expect((await put('text/html', PNG)).status).toBe(403);
    expect((await put('image/png', Buffer.concat([PNG, PNG]))).status).toBe(403);
    expect(await driver.head('t/a/1')).toBeNull();
    expect((await put('image/png', PNG)).status).toBe(200);
    expect(await driver.head('t/a/1')).toEqual({ size: PNG.length });
    expect((await driver.readStart('t/a/1', 8)).equals(PNG.subarray(0, 8))).toBe(true);
    expect((await driver.read('t/a/1')).equals(PNG)).toBe(true);

    const get = await driver.presignGet('t/a/1', {
      mime: 'image/png',
      disposition: 'inline; filename="a.png"',
      expiresIn: 60,
    });
    const served = await fetch(get);
    expect(served.status).toBe(200);
    expect(served.headers.get('content-type')).toBe('image/png');
    expect(served.headers.get('content-disposition')).toBe('inline; filename="a.png"');

    await driver.delete('t/a/1');
    await driver.delete('t/a/1');
    expect(await driver.head('t/a/1')).toBeNull();
  });
});
