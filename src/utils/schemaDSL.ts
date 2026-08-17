import type { Schema, Table, Column, Layout } from '../types/schema'

export const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/

// recognised column types (base name, before any length like varchar(255))
const KNOWN_TYPES = new Set([
  // integers
  'int', 'integer', 'int2', 'int4', 'int8', 'smallint', 'bigint', 'tinyint', 'mediumint',
  'serial', 'bigserial', 'smallserial', 'serial2', 'serial4', 'serial8',
  // numeric
  'decimal', 'numeric', 'real', 'double', 'float', 'float4', 'float8', 'money', 'number',
  // string
  'varchar', 'char', 'character', 'varying', 'text', 'tinytext', 'mediumtext', 'longtext',
  'string', 'nvarchar', 'nchar', 'citext',
  // boolean
  'boolean', 'bool', 'bit',
  // date / time
  'date', 'datetime', 'timestamp', 'timestamptz', 'time', 'timetz', 'year', 'interval',
  // uuid / json / xml
  'uuid', 'json', 'jsonb', 'xml',
  // binary
  'binary', 'varbinary', 'blob', 'tinyblob', 'mediumblob', 'longblob', 'bytea', 'clob',
  // misc
  'enum', 'set', 'array', 'inet', 'cidr', 'macaddr', 'point', 'geometry', 'geography', 'hstore',
])

function isKnownType(type: string): boolean {
  return KNOWN_TYPES.has(type.replace(/\(.*$/, '').toLowerCase())
}

export interface DSLDiagnostic { line: number; message: string }
export interface DSLResult {
  schema: Schema
  diagnostics: DSLDiagnostic[]
  // present only when a Layout "All tables" block was found in the text —
  // its positions live outside schema.layouts (that's the "All tables" view's
  // own master position set, not a named layout)
  masterPositions?: Record<string, { x: number; y: number }>
}

const ALL_TABLES_LAYOUT = 'All tables'

// ── Schema → DSL text ──────────────────────────────────────────────────────
// Tables hold only attributes; foreign keys live in a separate Relations block.
// Layout blocks hold per-table pixel positions — one implicit "All tables"
// block for the master view, then one per named layout.
export function schemaToDSL(schema: Schema, masterPositions: Record<string, { x: number; y: number }> = {}): string {
  const blocks = schema.tables.map(t => {
    const cols = t.columns.map(c => {
      const parts = [c.name, c.type]
      if (c.primaryKey) parts.push('pk')
      if (c.unique && !c.primaryKey) parts.push('unique')
      if (c.nullable) parts.push('null')
      return '  ' + parts.join(' ')
    })
    return `Table ${t.name} {\n${cols.join('\n')}\n}`
  })

  const rels: string[] = []
  for (const t of schema.tables) {
    for (const c of t.columns) {
      if (c.foreignKey) rels.push(`  ${t.name}.${c.name} > ${c.foreignKey.table}.${c.foreignKey.column}`)
    }
  }

  // Only show positions for tables that actually exist / actually belong to
  // the layout — a layout's .positions can carry stale leftovers (e.g. from a
  // table that was later removed from the layout, or deleted outright) that
  // predate this editor and were never visible anywhere before. Surfacing
  // them here would make the layout look like it has tables it doesn't.
  const tableNames = new Set(schema.tables.map(t => t.name))
  const posLines = (positions: Record<string, { x: number; y: number }>, allowed?: Set<string>) =>
    Object.entries(positions)
      .filter(([name]) => tableNames.has(name) && (!allowed || allowed.has(name)))
      .map(([name, p]) => `  ${name} ${Math.round(p.x)} ${Math.round(p.y)}`)
      .join('\n')

  const layoutBlocks = [
    `Layout "${ALL_TABLES_LAYOUT}" {\n${posLines(masterPositions)}\n}`,
    ...(schema.layouts ?? []).map(l => {
      const viewLine = l.viewMode && l.viewMode !== 'full' ? `  view ${l.viewMode}\n` : ''
      const lockedLine = l.locked ? `  locked\n` : ''
      return `Layout "${l.name}" {\n${viewLine}${lockedLine}${posLines(l.positions, new Set(l.tables))}\n}`
    }),
  ]

  return [...blocks, `Relations {\n${rels.join('\n')}\n}`, ...layoutBlocks].join('\n\n')
}

// ── DSL text → Schema + diagnostics ────────────────────────────────────────
const REL_RE = /^([A-Za-z_]\w*)\.([A-Za-z_]\w*)\s*>\s*([A-Za-z_]\w*)\.([A-Za-z_]\w*)$/

export function dslToSchema(text: string, prevSchema?: Schema): DSLResult {
  const prevTags = new Map(prevSchema?.tables.map(t => [t.name, t.tags ?? []]) ?? [])
  const prevLayouts = new Map(prevSchema?.layouts?.map(l => [l.name, l]) ?? [])
  const diagnostics: DSLDiagnostic[] = []
  const tables: Table[] = []
  const byName = new Map<string, Table>()
  const relLines: { line: number; text: string }[] = []
  const layouts: Layout[] = []
  let masterPositions: Record<string, { x: number; y: number }> | undefined
  // deferred like relLines — a layout's position lines reference table names
  // that may be declared later in the text, so they're validated in a second
  // pass once every Table block has been parsed
  const layoutBlocks: { name: string; lines: { line: number; text: string }[] }[] = []

  const lines = text.split('\n')
  let mode: 'none' | 'table' | 'relations' | 'layout' = 'none'
  let cur: Table | null = null
  let curCols: Set<string> | null = null
  let curLayoutLines: { line: number; text: string }[] | null = null

  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1
    const line = lines[i].trim()
    if (!line || line.startsWith('//') || line.startsWith('--')) continue

    if (mode === 'none') {
      if (/^Relations\b/i.test(line)) { mode = 'relations'; continue }
      const lm = /^Layout\s+"([^"]*)"\s*\{?\s*$/i.exec(line)
      if (lm) {
        const name = lm[1].trim()
        if (!name) diagnostics.push({ line: lineNo, message: `Layout name cannot be empty` })
        const blockLines: { line: number; text: string }[] = []
        layoutBlocks.push({ name, lines: blockLines })
        curLayoutLines = blockLines
        mode = 'layout'
        continue
      }
      const tm = /^Table\s+(.+?)\s*\{?\s*$/i.exec(line)
      if (tm) {
        const name = tm[1].trim()
        if (!IDENT.test(name)) diagnostics.push({ line: lineNo, message: `Invalid table name "${name}" — latin letters, digits and _ only` })
        if (byName.has(name)) diagnostics.push({ line: lineNo, message: `Duplicate table "${name}"` })
        cur = { name, columns: [], tags: prevTags.get(name) ?? [] }
        tables.push(cur); byName.set(name, cur)
        curCols = new Set()
        mode = 'table'
        continue
      }
      diagnostics.push({ line: lineNo, message: `Unexpected "${line}" — expected a Table, Relations or Layout block` })
      continue
    }

    if (mode === 'table') {
      if (line === '}') { mode = 'none'; cur = null; curCols = null; continue }
      if (line.includes('>')) diagnostics.push({ line: lineNo, message: `Put relations in the Relations { } block, not inside a table` })
      const tokens = line.split(/\s+/)
      const colName = tokens[0]
      const colType = tokens[1]
      if (!IDENT.test(colName)) diagnostics.push({ line: lineNo, message: `Invalid column name "${colName}" — latin letters, digits and _ only` })
      else if (!colType) diagnostics.push({ line: lineNo, message: `Column "${colName}" is missing a type` })
      else if (!isKnownType(colType)) diagnostics.push({ line: lineNo, message: `Unknown type "${colType}" for column "${colName}"` })
      if (cur && curCols) {
        if (curCols.has(colName)) diagnostics.push({ line: lineNo, message: `Duplicate column "${colName}" in "${cur.name}"` })
        curCols.add(colName)
        const col: Column = { name: colName, type: colType ?? 'varchar' }
        for (const f of tokens.slice(2)) {
          if (f === 'pk') col.primaryKey = true
          else if (f === 'unique') col.unique = true
          else if (f === 'null') col.nullable = true
        }
        cur.columns.push(col)
      }
      continue
    }

    if (mode === 'layout') {
      if (line === '}') { mode = 'none'; curLayoutLines = null; continue }
      curLayoutLines!.push({ line: lineNo, text: line })
      continue
    }

    // mode === 'relations'
    if (line === '}') { mode = 'none'; continue }
    relLines.push({ line: lineNo, text: line })
  }

  // validate relations against the parsed tables
  for (const { line, text: rel } of relLines) {
    const m = REL_RE.exec(rel)
    if (!m) { diagnostics.push({ line, message: `Invalid relation — expected "table.column > table.column"` }); continue }
    const [, sT, sC, tT, tC] = m
    const src = byName.get(sT)
    if (!src) { diagnostics.push({ line, message: `Unknown table "${sT}"` }); continue }
    const srcCol = src.columns.find(c => c.name === sC)
    if (!srcCol) { diagnostics.push({ line, message: `"${sT}" has no column "${sC}"` }); continue }
    const tgt = byName.get(tT)
    if (!tgt) { diagnostics.push({ line, message: `Unknown table "${tT}"` }); continue }
    const tgtCol = tgt.columns.find(c => c.name === tC)
    if (!tgtCol) { diagnostics.push({ line, message: `"${tT}" has no column "${tC}"` }); continue }
    // a source column being a primary key is NOT an error on its own — it's
    // exactly the shape of a composite-PK junction table (product_tags.tag_id
    // is both PK and FK) or a 1:1 extension table (child.id PK referencing
    // parent.id), both legitimate, common patterns.
    if (!tgtCol.primaryKey && !tgtCol.unique) { diagnostics.push({ line, message: `"${tT}.${tC}" must be a primary key or unique to be referenced` }); continue }
    srcCol.foreignKey = { table: tT, column: tC }
  }

  // validate layout position lines against the parsed tables
  for (const block of layoutBlocks) {
    const positions: Record<string, { x: number; y: number }> = {}
    let view: Layout['viewMode'] | undefined
    let locked = false
    for (const { line, text: raw } of block.lines) {
      const vm = /^view\s+(full|compact|collapsed)\s*$/i.exec(raw)
      if (vm) { view = vm[1].toLowerCase() as Layout['viewMode']; continue }
      if (/^locked\s*$/i.test(raw)) { locked = true; continue }
      const pm = /^([A-Za-z_]\w*)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s*$/.exec(raw)
      if (pm) {
        const [, tblName, xs, ys] = pm
        if (!byName.has(tblName)) diagnostics.push({ line, message: `Unknown table "${tblName}" in layout "${block.name}"` })
        else positions[tblName] = { x: parseFloat(xs), y: parseFloat(ys) }
        continue
      }
      diagnostics.push({ line, message: `Invalid line in layout block — expected "table x y", "view <full|compact|collapsed>" or "locked"` })
    }
    if (!block.name) continue
    if (block.name === ALL_TABLES_LAYOUT) {
      masterPositions = positions
    } else {
      const prev = prevLayouts.get(block.name)
      layouts.push({
        id: prev?.id ?? crypto.randomUUID(),
        name: block.name,
        tables: Object.keys(positions),
        positions,
        ...(view ? { viewMode: view } : {}),
        ...(locked ? { locked: true } : {}),
      })
    }
  }

  const schema: Schema = { tables }
  if (layouts.length) schema.layouts = layouts
  return { schema, diagnostics, masterPositions }
}
