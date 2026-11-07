// A resumed run's tool calls as thread parts, the way the chat service saves a turn's: what the
// chat renders (the outcome, what it showed, an approval, a refusal's reason), never the data.
import { randomUUID } from 'node:crypto';
import type { Present } from '@hykr/contracts';
import type { SavedPart } from '../../modules/threads/threads.service.js';

type RawToolResult = {
  toolName?: string;
  toolCallId?: string;
  args?: unknown;
  result?: {
    ok?: boolean;
    present?: Present;
    speech?: string;
    result?: { status?: string; approval?: unknown };
    error?: { reason?: string; message?: unknown } | null;
  };
};

function compact(result: RawToolResult['result']) {
  if (!result) return null;
  const { ok, present, speech, error } = result;
  const r = result.result;
  return {
    ok,
    ...(present ? { present } : {}),
    ...(speech ? { speech } : {}),
    ...(error ? { error: { reason: error.reason, message: error.message } } : {}),
    ...(r?.status ? { result: { status: r.status, approval: r.approval } } : {}),
  };
}

/** Each tool result (Mastra's chunks) as a saved UI part. */
export function partsOf(results: readonly unknown[]): SavedPart[] {
  return results.map((r) => {
    const x = (r && typeof r === 'object' && 'payload' in r ? r.payload : r) as RawToolResult;
    return {
      type: `tool-${x.toolName ?? 'tool'}`,
      toolCallId: x.toolCallId ?? randomUUID(),
      state: 'output-available',
      input: x.args ?? {},
      output: compact(x.result),
    };
  });
}
