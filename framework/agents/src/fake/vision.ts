// The scripted vision model: what reads files in fake mode (tests, CI). A file's "contents" are
// what its bytes (or a PDF page's text) carry after the marker FAKE-VISION:, so a test decides
// what the model "sees". Alternatives split by "|||" answer successive attempts in one call (the
// first, then the retry), so a test can make the first reply wrong and the retry right.
import type {
  LanguageModelV2,
  LanguageModelV2CallOptions,
  LanguageModelV2Content,
  LanguageModelV2Prompt,
} from '@ai-sdk/provider';

export const FAKE_VISION_MARKER = 'FAKE-VISION:';

/** What follows the marker in these bytes, up to a NUL or the end; undefined without one. */
function marked(data: unknown): string | undefined {
  let text: string;
  if (data instanceof Uint8Array) text = Buffer.from(data).toString('latin1');
  else if (typeof data === 'string')
    text = data.includes(FAKE_VISION_MARKER)
      ? data
      : Buffer.from(data, 'base64').toString('latin1');
  else return undefined;
  const at = text.indexOf(FAKE_VISION_MARKER);
  if (at < 0) return undefined;
  const rest = text.slice(at + FAKE_VISION_MARKER.length);
  const end = rest.indexOf('\u0000');
  // Bytes are latin1 here; the marked text is written as UTF-8.
  return Buffer.from((end < 0 ? rest : rest.slice(0, end)).trim(), 'latin1').toString('utf8');
}

/** What the model "sees" in the call: every marked file or text part, and how many files. */
function seen(prompt: LanguageModelV2Prompt) {
  const readings: string[] = [];
  let files = 0;
  for (const message of prompt) {
    if (message.role !== 'user') continue;
    for (const part of message.content) {
      if (part.type === 'file') {
        files++;
        const found = marked(part.data);
        if (found !== undefined) readings.push(found);
      } else if (part.type === 'text') {
        const found = marked(part.text);
        if (found !== undefined) readings.push(found);
      }
    }
  }
  return { readings: [...new Set(readings)], files };
}

/** Which attempt this is: one more than the replies already in the prompt. */
const attemptOf = (prompt: LanguageModelV2Prompt) =>
  prompt.filter((m) => m.role === 'assistant').length;

/** The reply to one call. */
export function visionReply(prompt: LanguageModelV2Prompt): string {
  const { readings, files } = seen(prompt);
  if (!readings.length) return `I see ${files} image${files === 1 ? '' : 's'} and no words.`;
  const attempt = attemptOf(prompt);
  return readings
    .map((r) => {
      const options = r.split('|||');
      return options[Math.min(attempt, options.length - 1)];
    })
    .join('\n');
}

/** Tokens as the scripted model counts them: a token per four characters, 258 per file. */
function usage(prompt: LanguageModelV2Prompt, reply: string) {
  let chars = 0;
  let files = 0;
  for (const message of prompt) {
    if (typeof message.content === 'string') chars += message.content.length;
    else
      for (const part of message.content)
        if (part.type === 'text') chars += part.text.length;
        else if (part.type === 'file') files++;
  }
  const inputTokens = Math.ceil(chars / 4) + files * 258;
  const outputTokens = Math.max(1, Math.ceil(reply.length / 4));
  return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens };
}

/** The scripted vision model: no network, no cost, a deterministic token count. */
export function fakeVisionModel(): LanguageModelV2 {
  return {
    specificationVersion: 'v2',
    provider: 'fake',
    modelId: 'scripted',
    supportedUrls: {},
    async doGenerate(options: LanguageModelV2CallOptions) {
      const text = visionReply(options.prompt);
      const content: LanguageModelV2Content[] = [{ type: 'text', text }];
      return {
        content,
        finishReason: 'stop',
        usage: usage(options.prompt, text),
        warnings: [],
      };
    },
    async doStream() {
      throw new Error('The scripted vision model does not stream');
    },
  };
}
