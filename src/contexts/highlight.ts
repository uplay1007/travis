import { createContext } from 'react'

export interface HighlightCtxValue {
  active: boolean
  highlighted: Set<string>   // lit set: focus + FK neighbors, or the manual selection
  focusTable: string | null  // the main table that was clicked
  groupMode: boolean         // true when a manual cmd-selection is active
  onHighlight: (name: string, mods: { cmd: boolean; alt: boolean; shift: boolean }) => void
}

export const HighlightCtx = createContext<HighlightCtxValue>({
  active: false,
  highlighted: new Set(),
  focusTable: null,
  groupMode: false,
  onHighlight: () => {},
})
