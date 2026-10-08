import { create } from 'zustand';

/**
 * What the person is typing to the assistant, kept outside the thread: the phone sheet
 * unmounts when it closes, and a half-written message (or pasted notes) must survive that.
 * The side panel and the sheet share it, so it is one draft on every screen size.
 */
export const useDraft = create<{ text: string; set: (text: string) => void }>((set) => ({
  text: '',
  set: (text) => set({ text }),
}));
