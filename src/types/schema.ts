export interface ForeignKey {
  table: string
  column: string
}

export interface Column {
  name: string
  type: string
  comment?: string
  primaryKey?: boolean
  foreignKey?: ForeignKey
  nullable?: boolean
  unique?: boolean
}

// Architectural role of a table (data-modeling classification), independent of
// the free-form tags. Drives coloring, filtering and layout plugins.
export type TableType = 'reference' | 'master' | 'transaction' | 'link' | 'dimension' | 'fact'

export interface Table {
  name: string
  columns: Column[]
  tags?: string[]
  type?: TableType
  // manual accent override (hex); when absent the accent is derived from the
  // first tag / the table name — see utils/colors.ts
  color?: string
}

export type ViewMode = 'collapsed' | 'compact' | 'full' | 'extended'

export interface Layout {
  id: string
  name: string
  tables: string[]                                    // table names shown in this layout
  positions: Record<string, { x: number; y: number }> // per-layout table positions
  viewMode?: ViewMode                                 // per-layout detail level
  locked?: boolean                                     // when true, tables can't be dragged on this layout's canvas
}

export interface Schema {
  tables: Table[]
  layouts?: Layout[]
}
