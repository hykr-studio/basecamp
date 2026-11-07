// Upload targets that are not an entity's file field (an import's file). Nothing here loads Nest.
import {
  type AuthorizeResult,
  createHookRegistry,
  type FileFieldPolicy,
  type Principal,
} from '@hykr/contracts';

declare module '@hykr/contracts' {
  interface Contributions {
    uploadTargets: readonly UploadTarget[];
  }
}

/**
 * Something a person uploads a file for that is no record's field: the file an import reads.
 * `POST /api/files { for: { entity: <type>, field } }` checks it as it checks a field (type and
 * size), then asks `may`. The file stays its uploader's own upload: it is reached by them alone
 * and never put on a record (the sweeper removes it once its grace period is over).
 */
export interface UploadTarget extends FileFieldPolicy {
  /** What `for.entity` names: 'import'. Never an entity's name. */
  type: string;
  /** What `for.field` names: 'file'. */
  field: string;
  /** Who may upload for it: a refusal is 403 with its rule. */
  may(p: Principal): AuthorizeResult;
}

/** Upload targets that are not entities, by type. */
export const uploadTargets = createHookRegistry<UploadTarget>('upload target', (t) => t.type, {
  collects: 'uploadTargets',
});
