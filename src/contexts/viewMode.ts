import { createContext } from 'react'
import type { ViewMode } from '../types/schema'
import type { Lang } from '../i18n'
export type { ViewMode } from '../types/schema'
export interface ViewModeCtxValue {
  mode: ViewMode
  lang: Lang
  bulkKey: number      // increments on mode switches that need a bulk expand/collapse
  bulkExpand: boolean  // true = expand all, false = collapse all
  readOnly: boolean
}
export const ViewModeCtx = createContext<ViewModeCtxValue>({ mode: 'full', lang: 'en', bulkKey: 0, bulkExpand: true, readOnly: false })
