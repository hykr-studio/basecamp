/**
 * Text cut to a channel's limit, on the gentlest break that fits: a paragraph, then a line,
 * then a word, and only as a last resort mid-word.
 */
export function split(text: string, limit: number): string[] {
  const chunks: string[] = [];
  let rest = text.trim();
  while (rest.length > limit) {
    const window = rest.slice(0, limit + 1);
    const at = [window.lastIndexOf('\n\n'), window.lastIndexOf('\n'), window.lastIndexOf(' ')].find(
      (i) => i > limit / 2,
    );
    const cut = at ?? limit;
    chunks.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) chunks.push(rest);
  return chunks;
}
