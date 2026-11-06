/**
 * The app path a tapped push opens: the notification's `url` when it is a path in this app
 * ('/todos'), never another site or scheme.
 */
export function appPathOf(data: unknown): string | undefined {
  const url = (data as { url?: unknown } | null | undefined)?.url;
  if (typeof url !== 'string' || !url.startsWith('/') || url.startsWith('//')) return undefined;
  return url;
}
