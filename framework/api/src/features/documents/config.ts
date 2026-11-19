import { createFakeEngine, createPdfEngine, type DocumentEngine } from './engine/index.js';

export type EngineKind = 'pdf' | 'fake';

/** How many and how big the images of one document may be (each a deployment setting). */
export interface ImageLimits {
  /** Images per document, every block and the header and footer: too_many_images. */
  maxCount: number;
  /** Bytes per image: image_too_large. */
  maxBytes: number;
  /** Pixels (width × height) per image: image_too_large. */
  maxPixels: number;
  /** Image bytes per document: images_too_large. */
  maxTotalBytes: number;
}

export interface DocumentsConfig {
  engine: EngineKind;
  images: ImageLimits;
}

const MB = 1024 * 1024;
export const IMAGE_LIMITS: ImageLimits = {
  maxCount: 200,
  maxBytes: 10 * MB,
  maxPixels: 40_000_000,
  maxTotalBytes: 60 * MB,
};

/** A positive whole number from the environment, or the default. */
function positive(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = (env[name] ?? '').trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0)
    throw new Error(`${name} must be a positive whole number (got "${raw}")`);
  return n;
}

/** The image limits: DOCUMENTS_IMAGES_MAX, DOCUMENTS_IMAGE_MAX_BYTES, _MAX_PIXELS, DOCUMENTS_IMAGES_MAX_BYTES. */
export function imageLimits(env: NodeJS.ProcessEnv = process.env): ImageLimits {
  return {
    maxCount: positive(env, 'DOCUMENTS_IMAGES_MAX', IMAGE_LIMITS.maxCount),
    maxBytes: positive(env, 'DOCUMENTS_IMAGE_MAX_BYTES', IMAGE_LIMITS.maxBytes),
    maxPixels: positive(env, 'DOCUMENTS_IMAGE_MAX_PIXELS', IMAGE_LIMITS.maxPixels),
    maxTotalBytes: positive(env, 'DOCUMENTS_IMAGES_MAX_BYTES', IMAGE_LIMITS.maxTotalBytes),
  };
}

/**
 * The documents feature's settings, read when called: `DOCUMENTS_ENGINE` is `pdf` (pdfkit with
 * HarfBuzz and the Noto fonts; the default) or `fake` (plain text lines; tests and CI), and the
 * image limits.
 */
export function documentsConfig(env: NodeJS.ProcessEnv = process.env): DocumentsConfig {
  const raw = (env.DOCUMENTS_ENGINE ?? '').trim().toLowerCase();
  if (raw && raw !== 'pdf' && raw !== 'fake')
    throw new Error(`DOCUMENTS_ENGINE must be pdf or fake (got "${raw}")`);
  return { engine: (raw || 'pdf') as EngineKind, images: imageLimits(env) };
}

/** Production never sends the fake engine's pages. */
export function assertDocumentsConfig(
  c: Pick<DocumentsConfig, 'engine'>,
  env: NodeJS.ProcessEnv = process.env,
) {
  if (env.NODE_ENV === 'production' && c.engine === 'fake')
    throw new Error('DOCUMENTS_ENGINE=fake is for tests: production draws real PDFs (pdf)');
}

/** The configured engine, checked. */
export function createEngine(c: DocumentsConfig = documentsConfig()): DocumentEngine {
  assertDocumentsConfig(c);
  return c.engine === 'fake' ? createFakeEngine() : createPdfEngine();
}
