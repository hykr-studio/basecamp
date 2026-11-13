import type { RenderTurn } from '@hykr/channels';
import type { ChatResponse, Principal } from '@hykr/contracts';
import { mayDecide } from '@hykr/core';
import { type Database, schema } from '@hykr/db';
import { inArray } from 'drizzle-orm';

type ApprovalRow = typeof schema.approvals.$inferSelect;

/** An agent turn's answer, as a channel without a screen renders it. */
export function toRenderTurn(turn: ChatResponse): RenderTurn {
  return {
    reply: turn.reply,
    // A parked call's card is the approval below (buttons, or a link), not words.
    views: turn.toolCalls.flatMap((c) =>
      c.present?.kind === 'text' && c.outcome !== 'parked'
        ? [{ text: c.present.text, heading: c.present.heading, choices: c.present.choices }]
        : [],
    ),
    approvals: turn.toolCalls.flatMap((c) =>
      c.outcome === 'parked' && c.approvalId ? [{ id: c.approvalId, summary: c.detail ?? '' }] : [],
    ),
  };
}

/**
 * What a turn parked that this person decides themselves: the same fact the waiting line reads
 * (the approval's `canDecide`, `mayDecide`). Those stay in the turn, with the approval's row; the
 * rest are someone else's (the business, for a customer's request, or whoever the approval names),
 * who is asked on their own, so they leave it: no buttons, and no "approve it in the app" beside a
 * line that says the team was asked. A request with no row is not theirs either.
 */
export function keepOwn(
  turn: RenderTurn,
  rows: readonly ApprovalRow[],
  p: Principal,
): { turn: RenderTurn; own: Map<string, ApprovalRow> } {
  const own = new Map(rows.filter((row) => mayDecide(row, p)).map((row) => [row.id, row]));
  return { turn: { ...turn, approvals: turn.approvals.filter((a) => own.has(a.id)) }, own };
}

/** `keepOwn`, with the rows of what the turn parked read from the database. */
export async function ownApprovals(db: Database, p: Principal, turn: RenderTurn) {
  const rows = turn.approvals.length
    ? await db
        .select()
        .from(schema.approvals)
        .where(
          inArray(
            schema.approvals.id,
            turn.approvals.map((a) => a.id),
          ),
        )
    : [];
  return keepOwn(turn, rows, p);
}
