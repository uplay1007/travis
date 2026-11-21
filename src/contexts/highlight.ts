import { createContext } from 'react'

export type TableSelectionGesture = 'toggle' | 'related' | 'exclusive'

export interface HighlightCtxValue {
  active: boolean
  highlighted: Set<string>   // lit set: focus + FK neighbors, or the manual selection
  selected: ReadonlySet<string>
  focusTable: string | null  // the main table that was clicked
  groupMode: boolean         // true when an explicit selection is active
  onHighlight: (name: string, gesture: TableSelectionGesture) => void
}

export const HighlightCtx = createContext<HighlightCtxValue>({
  active: false,
  highlighted: new Set(),
  selected: new Set(),
  focusTable: null,
  groupMode: false,
  onHighlight: () => {},
})
