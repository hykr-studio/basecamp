import type { Lang } from '@hykr/i18n';
import type { CheckedLayout } from '../layout.js';

/** What an engine knows of the document besides its layout. */
export interface RenderMeta {
  lang: Lang;
  /** The business, as the PDF's author. */
  author?: string;
  createdAt: Date;
}

/** A rendered document: its bytes and how many pages they hold. */
export interface Rendered {
  bytes: Buffer;
  pages: number;
}

/**
 * Turns a checked layout into a file. `pdf` (pdfkit, HarfBuzz shaping, the Noto fonts) in
 * production; `fake` (plain text lines in a minimal PDF) in tests and CI. Another engine
 * (Chromium) can sit behind the same interface.
 */
export interface DocumentEngine {
  readonly kind: string;
  /** The type of what it writes. */
  readonly mime: string;
  render(layout: CheckedLayout, meta: RenderMeta): Promise<Rendered>;
}

/** Inject the configured engine: `@Inject(DOCUMENT_ENGINE) engine: DocumentEngine`. */
export const DOCUMENT_ENGINE = Symbol('DOCUMENT_ENGINE');
