/** A short size for the assistant: 12 KB, 3.4 MB. */
export function sizeText(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * What the assistant reads about a file that came with a message, as data for the turn: its
 * name, type, size and id, and how to keep it (a record's file field).
 */
export const fileLine = (f: { id: string; name: string; mime: string; size: number }) =>
  `A file came with this message: "${f.name}" (${f.mime}, ${sizeText(f.size)}), file id ${f.id}. ` +
  "To keep it on a record, put this id in one of that record's file fields.";
