import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { FilesConfig } from '../config.js';
import { type StorageDriver, StorageUnavailable } from './driver.js';

const missing = (e: unknown) =>
  e instanceof S3ServiceException &&
  (e.$metadata?.httpStatusCode === 404 || e.name === 'NotFound' || e.name === 'NoSuchKey');

/**
 * The store's own refusal (a missing object, a bad request) is passed on; a store that is down
 * or failing is `StorageUnavailable` (503, try again).
 */
async function guard<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (e) {
    if (e instanceof S3ServiceException && (e.$metadata?.httpStatusCode ?? 500) < 500) throw e;
    throw new StorageUnavailable(e instanceof Error ? e.message : String(e));
  }
}

/**
 * An S3-compatible store: MinIO in development, any S3 elsewhere. The server talks to
 * `S3_ENDPOINT`; presigned URLs name `S3_PUBLIC_ENDPOINT`, which a phone can reach. Path-style
 * addressing whenever an endpoint is set (MinIO), and checksums only when the store requires
 * them, so a browser's or a phone's plain PUT matches the signature.
 */
export function s3Driver(c: FilesConfig['s3']): StorageDriver {
  const client = (endpoint: string | undefined) =>
    new S3Client({
      region: c.region,
      ...(endpoint ? { endpoint, forcePathStyle: true } : {}),
      credentials: { accessKeyId: c.accessKeyId, secretAccessKey: c.secretAccessKey },
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    });
  const server = client(c.endpoint);
  const signer = c.publicEndpoint === c.endpoint ? server : client(c.publicEndpoint);
  const Bucket = c.bucket;

  return {
    kind: 's3',
    async ensureReady() {
      await guard(async () => {
        try {
          await server.send(new HeadBucketCommand({ Bucket }));
        } catch (e) {
          if (!missing(e)) throw e;
          await server.send(new CreateBucketCommand({ Bucket }));
        }
      });
    },
    async presignPut(key, o) {
      // Content type and length are signed: the store refuses any other.
      const url = await getSignedUrl(
        signer,
        new PutObjectCommand({ Bucket, Key: key, ContentType: o.mime, ContentLength: o.size }),
        { expiresIn: o.expiresIn, signableHeaders: new Set(['content-type', 'content-length']) },
      );
      return { url, headers: { 'content-type': o.mime } };
    },
    presignGet: (key, o) =>
      getSignedUrl(
        signer,
        new GetObjectCommand({
          Bucket,
          Key: key,
          ResponseContentType: o.mime,
          ResponseContentDisposition: o.disposition,
        }),
        { expiresIn: o.expiresIn },
      ),
    async head(key) {
      try {
        const h = await guard(() => server.send(new HeadObjectCommand({ Bucket, Key: key })));
        return { size: Number(h.ContentLength ?? 0) };
      } catch (e) {
        if (missing(e)) return null;
        throw e;
      }
    },
    async readStart(key, bytes) {
      const out = await guard(() =>
        server.send(new GetObjectCommand({ Bucket, Key: key, Range: `bytes=0-${bytes - 1}` })),
      );
      return Buffer.from((await out.Body?.transformToByteArray()) ?? []);
    },
    async read(key) {
      const out = await guard(() => server.send(new GetObjectCommand({ Bucket, Key: key })));
      return Buffer.from((await out.Body?.transformToByteArray()) ?? []);
    },
    async put(key, bytes, mime) {
      await guard(() =>
        server.send(
          new PutObjectCommand({
            Bucket,
            Key: key,
            Body: bytes,
            ContentType: mime,
            ContentLength: bytes.length,
          }),
        ),
      );
    },
    async delete(key) {
      try {
        await guard(() => server.send(new DeleteObjectCommand({ Bucket, Key: key })));
      } catch (e) {
        if (!missing(e)) throw e;
      }
    },
  };
}
