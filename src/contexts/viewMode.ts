import { createContext } from 'react'
export type ViewMode = 'collapsed' | 'compact' | 'full'
export interface ViewModeCtxValue {
  mode: ViewMode
  bulkKey: number      // increments on mode switches that need a bulk expand/collapse
  bulkExpand: boolean  // true = expand all, false = collapse all
  readOnly: boolean
}
export const ViewModeCtx = createContext<ViewModeCtxValue>({ mode: 'full', bulkKey: 0, bulkExpand: true, readOnly: false })
