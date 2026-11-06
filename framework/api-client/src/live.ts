import type { LiveEvent } from '@hykr/contracts';

/** One server-sent event: its name (`message` when none) and its data lines joined. */
export type ServerSentEvent = { event: string; data: string };

/**
 * Server-sent events from a stream of text chunks: an event ends at a blank line, `event:` names
 * it, `data:` lines are joined, comments (`: ping`) are skipped. CRLF and CR count as line ends.
 */
export async function* readServerSentEvents(
  chunks: AsyncIterable<string>,
): AsyncGenerator<ServerSentEvent> {
  let buffer = '';
  const parse = (block: string): ServerSentEvent | undefined => {
    let event = 'message';
    const data: string[] = [];
    for (const line of block.split('\n')) {
      if (!line || line.startsWith(':')) continue;
      const colon = line.indexOf(':');
      const field = colon < 0 ? line : line.slice(0, colon);
      const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
      if (field === 'event') event = value;
      else if (field === 'data') data.push(value);
    }
    return data.length ? { event, data: data.join('\n') } : undefined;
  };
  for await (const chunk of chunks) {
    buffer += chunk.replace(/\r\n?/g, '\n');
    let end = buffer.indexOf('\n\n');
    while (end >= 0) {
      const parsed = parse(buffer.slice(0, end));
      buffer = buffer.slice(end + 2);
      if (parsed) yield parsed;
      end = buffer.indexOf('\n\n');
    }
  }
}

/** The live stream's events: `ready` once it listens, then one `change` per record event. */
export type LiveMessage = { kind: 'ready' } | { kind: 'change'; event: LiveEvent };

/** Only the stream's own events, parsed; anything else (a future event kind) is skipped. */
export async function* liveMessages(chunks: AsyncIterable<string>): AsyncGenerator<LiveMessage> {
  for await (const e of readServerSentEvents(chunks)) {
    if (e.event === 'ready') {
      yield { kind: 'ready' };
      continue;
    }
    if (e.event !== 'change') continue;
    try {
      const value = JSON.parse(e.data) as Partial<LiveEvent>;
      if (
        typeof value.name === 'string' &&
        typeof value.type === 'string' &&
        typeof value.id === 'string'
      )
        yield { kind: 'change', event: { name: value.name, type: value.type, id: value.id } };
    } catch {
      // Not JSON: skipped.
    }
  }
}

/**
 * A response body's bytes as text, chunk by chunk (fetch streaming: browsers, Node and Expo's
 * fetch). Through a reader, which every ReadableStream has, async iteration or not.
 */
export async function* textOf(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) yield decoder.decode(value, { stream: true });
    }
    const rest = decoder.decode();
    if (rest) yield rest;
  } finally {
    reader.releaseLock();
  }
}
