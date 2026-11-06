// A stub OpenAI-compatible gateway, served by the test process: chat completions (whole and
// streamed, with tool calls and token usage) and embeddings. It keeps every request, so a test can
// see which model and key reached it. Its replies follow the last message:
// - a tool result: "Done on <model>.";
// - "add <title>": a call to create-task with that title;
// - a structured-output request (the prompt-injection guardrail): no detection;
// - anything else: "Hello from <model>.".
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface GatewayRequest {
  path: string;
  model: string;
  authorization: string | null;
  stream: boolean;
  // biome-ignore lint/suspicious/noExplicitAny: the request as sent
  body: any;
}

type Message = { role: string; content?: unknown };

const USAGE = { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 };

/** A message's text: a string, or its text parts joined. */
function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content))
    return content
      .map((p) => (p && typeof p === 'object' && 'text' in p ? String(p.text) : ''))
      .join('');
  return '';
}

type Reply = { text: string } | { tool: { name: string; args: object } };

function replyTo(body: { model: string; messages: Message[]; response_format?: unknown }): Reply {
  if (body.response_format) return { text: JSON.stringify({ categories: null, reason: null }) };
  const last = body.messages.at(-1);
  if (last?.role === 'tool') return { text: `Done on ${body.model}.` };
  const said = textOf([...body.messages].reverse().find((m) => m.role === 'user')?.content);
  const add = /^add (.+)$/i.exec(said.trim());
  if (add) return { tool: { name: 'create-task', args: { title: add[1] } } };
  return { text: `Hello from ${body.model}.` };
}

let calls = 0;

function whole(res: ServerResponse, model: string, reply: Reply) {
  const id = `call_${++calls}`;
  const message =
    'text' in reply
      ? { role: 'assistant', content: reply.text }
      : {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id,
              type: 'function',
              function: { name: reply.tool.name, arguments: JSON.stringify(reply.tool.args) },
            },
          ],
        };
  send(res, 200, {
    id: `chatcmpl-${calls}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: 'text' in reply ? 'stop' : 'tool_calls' }],
    usage: USAGE,
  });
}

function streamed(res: ServerResponse, model: string, reply: Reply) {
  const id = `call_${++calls}`;
  const chunk = (choices: unknown[], extra: object = {}) =>
    `data: ${JSON.stringify({
      id: `chatcmpl-${calls}`,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model,
      choices,
      ...extra,
    })}\n\n`;
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  res.write(chunk([{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }]));
  if ('text' in reply) {
    // In two pieces, as a gateway streams.
    const half = Math.ceil(reply.text.length / 2);
    for (const piece of [reply.text.slice(0, half), reply.text.slice(half)])
      res.write(chunk([{ index: 0, delta: { content: piece }, finish_reason: null }]));
  } else {
    const call = {
      index: 0,
      id,
      type: 'function',
      function: { name: reply.tool.name, arguments: JSON.stringify(reply.tool.args) },
    };
    res.write(chunk([{ index: 0, delta: { tool_calls: [call] }, finish_reason: null }]));
  }
  res.write(
    chunk([{ index: 0, delta: {}, finish_reason: 'text' in reply ? 'stop' : 'tool_calls' }]),
  );
  res.write(chunk([], { usage: USAGE }));
  res.end('data: [DONE]\n\n');
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function read(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

/** A word's vector: three numbers from its letters, so equal texts embed equally. */
const vectorOf = (text: string) => [text.length, text.charCodeAt(0) || 0, 1];

export interface StubGateway {
  /** http://127.0.0.1:<port> */
  url: string;
  requests: GatewayRequest[];
  close(): Promise<void>;
}

/** Start the stub on a free port. */
export async function startGateway(): Promise<StubGateway> {
  const requests: GatewayRequest[] = [];
  const server: Server = createServer((req, res) => {
    read(req)
      .then((body) => {
        const path = req.url ?? '';
        requests.push({
          path,
          model: String(body.model ?? ''),
          authorization: req.headers.authorization ?? null,
          stream: body.stream === true,
          body,
        });
        if (req.method === 'POST' && path.endsWith('/chat/completions')) {
          const reply = replyTo(body);
          return body.stream ? streamed(res, body.model, reply) : whole(res, body.model, reply);
        }
        if (req.method === 'POST' && path.endsWith('/embeddings')) {
          const input: string[] = Array.isArray(body.input) ? body.input : [body.input];
          return send(res, 200, {
            object: 'list',
            model: body.model,
            data: input.map((text, index) => ({
              object: 'embedding',
              index,
              embedding: vectorOf(text),
            })),
            usage: { prompt_tokens: input.length, total_tokens: input.length },
          });
        }
        send(res, 404, { error: { message: `No route ${req.method} ${path}` } });
      })
      .catch((e) => send(res, 500, { error: { message: String(e) } }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
