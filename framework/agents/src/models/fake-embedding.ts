import type { OpenAICompatibleProvider } from '@ai-sdk/openai-compatible';

export type EmbeddingModel = ReturnType<OpenAICompatibleProvider['embeddingModel']>;

const DIMENSIONS = 256;

/** FNV-1a, 32 bits: the same word always lands in the same dimension. */
function hash(word: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < word.length; i++) {
    h ^= word.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Fake mode's embedding: each word (letters and digits, lower case) adds 1 to the dimension it
 * hashes to, then the vector is scaled to length 1. Texts that share words are close, so recall
 * can be tested without a model. The same text always gives the same vector.
 */
export function embedText(text: string): number[] {
  const v = new Array<number>(DIMENSIONS).fill(0);
  for (const word of text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
    v[hash(word) % DIMENSIONS] += 1;
  const length = Math.hypot(...v);
  return length ? v.map((x) => x / length) : v;
}

export const fakeEmbeddingModel = (id: string): EmbeddingModel => ({
  specificationVersion: 'v4',
  provider: 'fake',
  modelId: id,
  maxEmbeddingsPerCall: 512,
  supportsParallelCalls: true,
  async doEmbed({ values }) {
    return {
      embeddings: values.map(embedText),
      usage: { tokens: values.reduce((n, s) => n + (s.match(/\S+/g)?.length ?? 0), 0) },
      warnings: [],
    };
  },
});
