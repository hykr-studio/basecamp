import type { FileFieldPolicy, FileInfo, FileTarget } from '@hykr/contracts';
import { type UseQueryResult, useMutation, useQuery } from '@tanstack/react-query';
import { api } from '../../api';
import { getCatalog } from '../../runtime';

/** A file picked on the device, ready to upload. */
export type PickedFile = { body: Blob; name: string; mime: string };

/** The rules of one entity's file field, from the catalog (the spec's `files` trait). */
export function fileFieldPolicy(entity: string, field: string): FileFieldPolicy | undefined {
  const spec = Object.values(getCatalog().entities).find((s) => s.name === entity);
  const files = spec?.traits?.files ?? {};
  return Object.hasOwn(files, field) ? files[field] : undefined;
}

/**
 * These files' details and short-lived URLs, as the caller may reach them (through the record
 * each is on); ids it cannot reach are left out. Refreshed before the URLs expire.
 */
export function useFiles(ids: readonly string[]): UseQueryResult<FileInfo[]> {
  return useQuery({
    queryKey: ['files', [...ids]],
    queryFn: () => api.files.getMany(ids),
    enabled: ids.length > 0,
    staleTime: 4 * 60_000,
    refetchInterval: 4 * 60_000,
  });
}

/** Upload one picked file for an entity's file field: presign, send the bytes, confirm. */
export function useFileUpload() {
  return useMutation({
    mutationFn: (a: { file: PickedFile; for: FileTarget }) =>
      api.files.upload(a.file.body, { name: a.file.name, mime: a.file.mime, for: a.for }),
  });
}
