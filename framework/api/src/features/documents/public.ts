// What applications and other features use of documents on the server: declaring a document,
// its layout, the engines, and the service that reads and draws documents.
import './routes.js';

export { type DocumentRow, reachable as reachableDocument } from './access.js';
export { layoutOf } from './commands.js';
export { type DocumentsConfig, documentsConfig } from './config.js';
export {
  channelsOf,
  type DocumentBusiness,
  type DocumentDef,
  type DocumentLoadContext,
  type DocumentRenderContext,
  type DocumentSendRequest,
  defineDocument,
  documents,
} from './define.js';
export { DocumentsService } from './documents.service.js';
export {
  createFakeEngine,
  createPdfEngine,
  DOCUMENT_ENGINE,
  type DocumentEngine,
  fontFile,
  harfbuzz,
  loadFonts,
  type Rendered,
  type RenderMeta,
  scriptRuns,
  shaperFor,
} from './engine/index.js';
export {
  type CheckedLayout,
  DocumentBlock,
  DocumentLayout,
  layoutLines,
  pageText,
} from './layout.js';
