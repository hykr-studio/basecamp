import type { RenderTurn } from '@app/channels';
import type { ChatResponse } from '@app/contracts';

/** An agent turn's answer, as a channel without a screen renders it. */
export function toRenderTurn(turn: ChatResponse): RenderTurn {
  return {
    reply: turn.reply,
    // A parked call's card is the approval below (buttons, or a link), not words.
    views: turn.toolCalls.flatMap((c) =>
      c.present?.kind === 'text' && c.outcome !== 'parked'
        ? [{ text: c.present.text, choices: c.present.choices }]
        : [],
    ),
    approvals: turn.toolCalls.flatMap((c) =>
      c.outcome === 'parked' && c.approvalId ? [{ id: c.approvalId, summary: c.detail ?? '' }] : [],
    ),
  };
}
