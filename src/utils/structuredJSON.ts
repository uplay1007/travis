import type { Schema, Table, Column, Layout, TableType } from '../types/schema'
import { tagColor } from './colors'

// ── Public JSON format ─────────────────────────────────────────────────────
// A human-readable structure split into four sections. Foreign keys live only
// in Relations (not duplicated on columns); groups are derived from tags.

export interface StructuredColumn {
  name: string
  type: string
  pk?: boolean
  unique?: boolean
  nullable?: boolean
}
export interface StructuredTable {
  name: string
  type?: TableType
  columns: StructuredColumn[]
}
export interface StructuredLayout {
  name: string
  parameters: { view: 'full' | 'compact' | 'collapsed' }
  positions: Record<string, { x: number; y: number }>
}
export interface StructuredGroup {
  tag: string
  color: string
  tables: string[]
}
export interface StructuredSchema {
  Tables: StructuredTable[]
  Relations: string[]
  Layouts: StructuredLayout[]
  Groups: StructuredGroup[]
}

// distinguishes the public format ("Tables") from the legacy internal one ("tables")
export function isStructuredSchema(raw: unknown): raw is StructuredSchema {
  const o = raw as Record<string, unknown>
  return !!o && (Array.isArray(o.Tables) || Array.isArray(o.Relations))
}

export function schemaToStructured(schema: Schema, masterPositions: Record<string, { x: number; y: number }> = {}): StructuredSchema {
  const Tables: StructuredTable[] = schema.tables.map(t => ({
    name: t.name,
    ...(t.type ? { type: t.type } : {}),
    columns: t.columns.map(c => {
      const col: StructuredColumn = { name: c.name, type: c.type }
      if (c.primaryKey) col.pk = true
      if (c.unique) col.unique = true
      if (c.nullable) col.nullable = true
      return col
    }),
  }))

  const Relations: string[] = []
  for (const t of schema.tables) {
    for (const c of t.columns) {
      if (c.foreignKey) Relations.push(`${t.name}.${c.name} > ${c.foreignKey.table}.${c.foreignKey.column}`)
    }
  }

  // "All tables" always comes first — it's the base view's own positions,
  // kept alongside (not merged into) any named layouts below it.
  const Layouts: StructuredLayout[] = [
    { name: 'All tables', parameters: { view: 'full' }, positions: masterPositions },
    ...(schema.layouts ?? []).map(l => ({
      name: l.name,
      parameters: { view: l.viewMode ?? 'full' },
      positions: l.positions,
    })),
  ]

  const tagTables = new Map<string, string[]>()
  for (const t of schema.tables) {
    for (const tag of (t.tags ?? [])) {
      if (!tagTables.has(tag)) tagTables.set(tag, [])
      tagTables.get(tag)!.push(t.name)
    }
  }
  const Groups: StructuredGroup[] = [...tagTables.entries()].map(([tag, tables]) => ({
    tag,
    color: tagColor([tag]),
    tables,
  }))

  return { Tables, Relations, Layouts, Groups }
}

const REL_RE = /^\s*(\w+)\.(\w+)\s*>\s*(\w+)\.(\w+)\s*$/

export function structuredToSchema(raw: StructuredSchema): Schema {
  if (!Array.isArray(raw.Tables)) throw new Error('Expected a "Tables" array')

  const tables: Table[] = raw.Tables.map(t => {
    if (typeof t.name !== 'string' || !t.name) throw new Error('Table missing name')
    if (!Array.isArray(t.columns)) throw new Error(`Table "${t.name}" missing columns array`)
    const columns: Column[] = t.columns.map(c => {
      if (typeof c.name !== 'string' || !c.name) throw new Error(`Column in "${t.name}" missing name`)
      const col: Column = { name: c.name, type: c.type || 'varchar', nullable: c.nullable ?? false }
      if (c.pk) col.primaryKey = true
      if (c.unique) col.unique = true
      return col
    })
    const table: Table = { name: t.name, columns, tags: [] }
    if (t.type) table.type = t.type
    return table
  })

  const byName = new Map(tables.map(t => [t.name, t]))

  for (const rel of (raw.Relations ?? [])) {
    const m = REL_RE.exec(rel)
    if (!m) continue
    const [, childTable, childCol, parentTable, parentCol] = m
    const col = byName.get(childTable)?.columns.find(c => c.name === childCol)
    if (col) col.foreignKey = { table: parentTable, column: parentCol }
  }

  for (const g of (raw.Groups ?? [])) {
    if (!g.tag) continue
    for (const tblName of (g.tables ?? [])) {
      const t = byName.get(tblName)
      if (t && !t.tags!.includes(g.tag)) t.tags!.push(g.tag)
    }
  }

  const layouts: Layout[] = (raw.Layouts ?? []).map(l => ({
    id: crypto.randomUUID(),
    name: l.name || 'Layout',
    tables: Object.keys(l.positions ?? {}),
    positions: l.positions ?? {},
    viewMode: l.parameters?.view,
  }))

  const schema: Schema = { tables }
  if (layouts.length) schema.layouts = layouts
  return schema
}
