import { createFakeEngine, createPdfEngine, type DocumentEngine } from './engine/index.js';

export type EngineKind = 'pdf' | 'fake';

export interface DocumentsConfig {
  engine: EngineKind;
}

/**
 * The documents feature's settings, read when called: `DOCUMENTS_ENGINE` is `pdf` (pdfkit with
 * HarfBuzz and the Noto fonts; the default) or `fake` (plain text lines; tests and CI).
 */
export function documentsConfig(env: NodeJS.ProcessEnv = process.env): DocumentsConfig {
  const raw = (env.DOCUMENTS_ENGINE ?? '').trim().toLowerCase();
  if (raw && raw !== 'pdf' && raw !== 'fake')
    throw new Error(`DOCUMENTS_ENGINE must be pdf or fake (got "${raw}")`);
  return { engine: (raw || 'pdf') as EngineKind };
}

/** Production never sends the fake engine's pages. */
export function assertDocumentsConfig(c: DocumentsConfig, env: NodeJS.ProcessEnv = process.env) {
  if (env.NODE_ENV === 'production' && c.engine === 'fake')
    throw new Error('DOCUMENTS_ENGINE=fake is for tests: production draws real PDFs (pdf)');
}

/** The configured engine, checked. */
export function createEngine(c: DocumentsConfig = documentsConfig()): DocumentEngine {
  assertDocumentsConfig(c);
  return c.engine === 'fake' ? createFakeEngine() : createPdfEngine();
}
