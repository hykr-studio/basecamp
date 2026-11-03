/**
 * The back office's view of conversations a person has taken from the assistant (handoffs),
 * and of the WhatsApp templates. Served under /api/backoffice to the business's staff only.
 */
export type HandoffState = 'open' | 'taken' | 'closed';

export type InboxItem = {
  id: string;
  state: HandoffState;
  /** customer_asked, agent_failed, agent_tool, staff_took. */
  reason: string;
  takenBy: string | null;
  openedAt: string;
  /** Nobody took it for a day. */
  flagged: boolean;
  contact: { id: string; name: string | null; address: string; locale: string };
  lastInboundAt: string | null;
  /** After this, only an approved template reaches them. */
  windowEndsAt: string | null;
};

export type Inbox = { open: InboxItem[]; mine: InboxItem[]; waiting: InboxItem[] };

export type HandoffThread = InboxItem & {
  messages: { id: string; role: 'user' | 'assistant'; text: string; at: string }[];
};

export type TemplateStatus = {
  name: string;
  language: string;
  category: string;
  status: string;
  rejectedReason: string | null;
  syncedAt: string | null;
};
