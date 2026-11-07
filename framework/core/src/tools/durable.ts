// Durable runs (A7): a tool whose write the API parked suspends the agent's run, and answers
// with the decision when the run is resumed. The run's snapshot is Mastra's; what a resume needs
// to rebuild the turn travels in the suspend payload. docs/decisions/A7.md.
import type { Present, Surface, WriteResult } from '@hykr/contracts';
import { z } from 'zod';

/** How the turn that parked was set up: enough to resume it as the same person, in the same place. */
export type RunContext = {
  /** Whom the run acts for: "user:<id>", "contact:<id>" (or a bare user id, from Studio). */
  actingFor: string;
  tenantId?: string;
  userId?: string;
  channel?: string;
  lang?: string;
  timeZone?: string;
  surfaces?: Surface[];
  screen?: string;
  record?: { type: string; id: string };
  /** The business's agent this run is (A6): its tools then call the API with the run's token. */
  agent?: string;
};

/** What every generated tool returns (see `safely`): what the model and the channels read. */
export type ToolOutcome = {
  ok: boolean;
  result?: unknown;
  status?: number;
  error?: unknown;
  present?: Present;
  speech?: string;
};

/**
 * A run suspended on a parked write: which approval it waits for, what the tool showed while it
 * waited (its approval card), and how to rebuild the turn. Stored in the run's snapshot.
 */
export type ParkedCall = {
  kind: 'approval';
  approvalId: string;
  summary: string | null;
  output: ToolOutcome;
  context: RunContext;
};

/** Is this a suspend payload a parked call made? */
export function isParkedCall(x: unknown): x is ParkedCall {
  const p = x as Partial<ParkedCall> | null;
  return (
    !!p &&
    typeof p === 'object' &&
    p.kind === 'approval' &&
    typeof p.approvalId === 'string' &&
    !!p.output &&
    typeof p.output === 'object' &&
    !!p.context &&
    typeof p.context.actingFor === 'string'
  );
}

/** How a parked request was decided, as the resume hands it to the tool. */
export const ResumeDecision = z.object({
  approvalId: z.string(),
  status: z.enum(['approved', 'rejected', 'expired', 'failed']),
  /** Why an approved replay could not be done (status failed). */
  reason: z.string().nullish(),
  summary: z.string().nullish(),
  resourceType: z.string().nullish(),
  resourceId: z.string().nullish(),
  decidedAt: z.string().nullish(),
});
export type ResumeDecision = z.infer<typeof ResumeDecision>;

type RequestContextLike = { get(key: string): unknown } | undefined;

const text = (v: unknown) => (typeof v === 'string' && v ? v : undefined);

/**
 * The turn's request context as a resume needs it again (the chat endpoint set these keys). The
 * page on the canvas is left out: it is a hint, and can be large.
 */
export function runContextOf(rc: RequestContextLike): RunContext {
  const record = rc?.get('record') as { type?: unknown; id?: unknown } | undefined;
  const surfaces = rc?.get('surfaces');
  const actingFor = text(rc?.get('actingFor')) ?? text(rc?.get('userId')) ?? '';
  const pick = (key: keyof RunContext) => {
    const v = text(rc?.get(key));
    return v ? { [key]: v } : {};
  };
  return {
    actingFor,
    ...pick('tenantId'),
    ...pick('userId'),
    ...pick('channel'),
    ...pick('lang'),
    ...pick('timeZone'),
    ...pick('screen'),
    ...pick('agent'),
    ...(Array.isArray(surfaces) ? { surfaces: surfaces as Surface[] } : {}),
    ...(record && typeof record.type === 'string' && typeof record.id === 'string'
      ? { record: { type: record.type, id: record.id } }
      : {}),
  };
}

/** The parked request in a write's answer, if it parked. */
export function parkedApproval(result: unknown) {
  const r = result as WriteResult<unknown> | undefined;
  return r?.status === 'needs_approval' ? r.approval : undefined;
}

/**
 * What a resumed call says, from the decision of its own approval. Approved: done, by the replay
 * the approval ran (the written value is not kept). Rejected or expired: nothing changed.
 * Failed: approved, but the replay was refused, which reads as any refusal. A decision about
 * another approval, or none, is refused: no resume may claim a decision it was not given.
 */
export function decisionOutcome(parked: ParkedCall | undefined, resumeData: unknown) {
  const parsed = ResumeDecision.safeParse(resumeData);
  if (!parked || !parsed.success || parsed.data.approvalId !== parked.approvalId)
    return {
      ok: false as const,
      status: 409,
      error: {
        error: 'not_decided',
        reason: 'This run continues only once its approval is decided',
      },
    };
  const d = parsed.data;
  const approval = {
    id: d.approvalId,
    status: d.status,
    summary: d.summary ?? parked.summary,
    resourceType: d.resourceType ?? null,
    resourceId: d.resourceId ?? null,
    decidedAt: d.decidedAt ?? null,
  };
  if (d.status === 'failed')
    return {
      ok: false as const,
      status: 409,
      error: {
        error: 'approval_failed',
        reason: d.reason ?? 'It was approved, but it could not be done',
      },
      result: { status: d.status, approval },
    };
  return { ok: true as const, result: { status: d.status, approval } };
}
