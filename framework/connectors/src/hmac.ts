import { createHmac, timingSafeEqual } from 'node:crypto';

/** How a digest is written as text. */
export type DigestEncoding = 'hex' | 'base64' | 'base64url';

/** The hashes a signature may use. */
export type HmacAlgorithm = 'sha256' | 'sha512' | 'sha1';

/** An HMAC of the payload (the exact bytes received or sent) with the secret, as text. */
export function hmacDigest(
  secret: string | Buffer,
  payload: string | Buffer,
  options: { algorithm?: HmacAlgorithm; encoding?: DigestEncoding } = {},
): string {
  return createHmac(options.algorithm ?? 'sha256', secret)
    .update(payload)
    .digest(options.encoding ?? 'hex');
}

/** Equal, in constant time for equal lengths. Different lengths are simply unequal. */
export function safeEqual(a: string | Buffer, b: string | Buffer): boolean {
  const x = typeof a === 'string' ? Buffer.from(a) : a;
  const y = typeof b === 'string' ? Buffer.from(b) : b;
  return x.length === y.length && timingSafeEqual(x, y);
}

export interface VerifyHmacOptions {
  secret: string | Buffer;
  /** The exact bytes that were signed: the raw request body, never a re-serialised object. */
  payload: string | Buffer;
  /** The signature as received (a header's value). */
  signature: string | readonly string[] | undefined;
  /** Text before the digest, such as 'sha256='. */
  prefix?: string;
  algorithm?: HmacAlgorithm;
  encoding?: DigestEncoding;
}

/**
 * Is `signature` the HMAC of `payload` with `secret`? False for a missing secret or signature, a
 * wrong prefix or a digest that differs. The comparison takes constant time. Hex digests are
 * compared case-insensitively, as senders write them either way.
 */
export function verifyHmac(o: VerifyHmacOptions): boolean {
  const given = Array.isArray(o.signature) ? o.signature[0] : (o.signature as string | undefined);
  if (!o.secret || o.secret.length === 0 || !given) return false;
  const prefix = o.prefix ?? '';
  if (!given.startsWith(prefix)) return false;
  const encoding = o.encoding ?? 'hex';
  let digest = given.slice(prefix.length).trim();
  if (encoding === 'hex') digest = digest.toLowerCase();
  const expected = hmacDigest(o.secret, o.payload, { algorithm: o.algorithm, encoding });
  return safeEqual(expected, digest);
}
