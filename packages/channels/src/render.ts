import type { Choice } from '@app/contracts';
import { type Lang, t } from '@app/i18n';
import type { OutboundMessage } from './adapter.js';
import { split } from './split.js';
import { WHATSAPP_LIMITS } from './whatsapp/adapter.js';

/** A finished agent turn, as a channel without a screen renders it. */
export type RenderTurn = {
  /** What the assistant said. */
  reply: string;
  /** Views its tools showed, already in words (the text surface), with a list's rows to tap. */
  views: { text: string; choices?: Choice[] }[];
  /** Actions parked for a person's approval. */
  approvals: { id: string; summary: string }[];
  /** Pages the assistant composed: a channel without a canvas links to them. */
  pages?: { title: string; url: string }[];
};

export type RenderOptions = {
  to: string;
  lang: Lang;
  /** The app, for "more in the app" and "approve it in the app". */
  appUrl: string;
  /**
   * Signed Approve / Reject payloads for one approval, when it may be decided here; without
   * them (an app-only action, or no signing key), the message says to approve it in the app.
   */
  approvalButtons?: (approvalId: string) => { approve: string; reject: string } | undefined;
};

/** A list's heading: its first line, without the list. */
const heading = (text: string) => text.split('\n')[0]?.trim() || text.trim();

/**
 * One agent turn as the messages that carry it, in order: the words first (split to the
 * channel's limit), then each list as buttons (2–3 rows) or a list (up to 10, the rest in the
 * app), then each approval with Approve and Reject, then links to composed pages.
 */
export function render(turn: RenderTurn, o: RenderOptions): OutboundMessage[] {
  const out: OutboundMessage[] = [];
  const words: string[] = [turn.reply.trim()];
  const interactive: OutboundMessage[] = [];

  for (const view of turn.views) {
    const rows = view.choices ?? [];
    if (rows.length < 2) {
      words.push(view.text);
      continue;
    }
    const text = heading(view.text);
    if (rows.length <= WHATSAPP_LIMITS.maxButtons)
      interactive.push({
        kind: 'buttons',
        to: o.to,
        text,
        buttons: rows.map((r) => ({ id: `pick:${r.id}`, title: r.title })),
      });
    else {
      interactive.push({
        kind: 'list',
        to: o.to,
        text,
        button: t(o.lang, 'channel.choose'),
        rows: rows
          .slice(0, WHATSAPP_LIMITS.maxListRows)
          .map((r) => ({ id: `pick:${r.id}`, title: r.title, description: r.description })),
      });
      if (rows.length > WHATSAPP_LIMITS.maxListRows)
        words.push(t(o.lang, 'channel.moreInApp', { url: o.appUrl }));
    }
  }

  for (const a of turn.approvals) {
    const buttons = o.approvalButtons?.(a.id);
    if (buttons)
      interactive.push({
        kind: 'buttons',
        to: o.to,
        text: a.summary,
        buttons: [
          { id: buttons.approve, title: t(o.lang, 'approval.approve') },
          { id: buttons.reject, title: t(o.lang, 'approval.reject') },
        ],
      });
    else
      words.push(
        t(o.lang, 'channel.approveInApp', { summary: a.summary, url: `${o.appUrl}/approvals` }),
      );
  }
  for (const page of turn.pages ?? [])
    words.push(t(o.lang, 'channel.page', { title: page.title, url: page.url }));

  const text = words.filter((w) => w.trim()).join('\n\n');
  for (const chunk of split(text, WHATSAPP_LIMITS.maxTextLength))
    out.push({ kind: 'text', to: o.to, text: chunk });
  return [...out, ...interactive];
}
