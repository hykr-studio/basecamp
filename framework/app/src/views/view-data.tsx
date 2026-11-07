import { createContext, type ReactNode, useContext } from 'react';

/** What a provider gives one view: a list's rows, one record, or a summary. */
export type ProvidedData = { items?: unknown[]; record?: unknown; summary?: unknown };

/**
 * Where views get their data when not from the person's session (decisions B9): a share page
 * hands each view what the share route returned, by the key the view was rendered with
 * (`InlineView dataKey`). `readOnly`: the views' actions do nothing (a guest acts on nothing).
 */
export interface ViewData {
  data(key: string): ProvidedData | undefined;
  readOnly?: boolean;
}

const ViewDataContext = createContext<ViewData | null>(null);

/** Views under it read their data from `value` instead of fetching it. */
export function ViewDataProvider({ value, children }: { value: ViewData; children: ReactNode }) {
  return <ViewDataContext.Provider value={value}>{children}</ViewDataContext.Provider>;
}

/** The provider views are under, or null: they fetch with the person's session. */
export const useViewData = () => useContext(ViewDataContext);
