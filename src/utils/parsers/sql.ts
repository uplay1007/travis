import type { Schema, Table, Column } from '../../types/schema'

// Split column lists and definitions without cutting through type parameters
// or quoted values (including comma-separated enum labels).
function splitTopLevel(s: string, separator: RegExp): string[] {
  const parts: string[] = []
  let depth = 0, start = 0
  let quote = ''
  for (let i = 0; i < s.length; i++) {
    const char = s[i]
    if (quote) {
      if (char === quote) quote = ''
      else if (char === '\\') i++
    } else if (char === "'" || char === '"' || char === '`') quote = char
    else if (char === '(') depth++
    else if (char === ')') depth--
    else if (depth === 0 && separator.test(char)) {
      parts.push(s.slice(start, i))
      start = i + 1
    }
  }
  parts.push(s.slice(start))
  return parts
}

const COLUMN_CONSTRAINT = /^(?:not|null|default|primary|unique|references|check|constraint|collate|generated|auto_increment|comment|on|unsigned|zerofill)(?:$|\()/i
const COMMENT_ESCAPES: Record<string, string> = { b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' }

export function parseSQL(text: string): Schema {
  const tables: Table[] = []

  // Extract @tags comments before stripping: map tableName → tags[]
  const tagsMap: Record<string, string[]> = {}
  // Matches -- @tags: x, y followed by optional comments/newlines then CREATE TABLE name
  const tagsLineRegex = /--\s*@tags:\s*([^\n]+)\s*(?:--[^\n]*\s*|\/\*[\s\S]*?\*\/\s*)*CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"']?(\w+)[`"']?/gi
  let tm: RegExpExecArray | null
  while ((tm = tagsLineRegex.exec(text)) !== null) {
    const tags = tm[1].split(',').map(t => t.trim()).filter(Boolean)
    const tableName = tm[2]
    tagsMap[tableName] = tags
  }

  // Preserve quoted SQL values while stripping source-code comments.
  const clean = text.replace(/\bE'(?:\\[\s\S]|''|[^'\\])*'|'(?:''|[^'])*'|\/\*[\s\S]*?\*\/|--[^\n]*/gi,
    token => token.startsWith('/*') || token.startsWith('--') ? ' ' : token)

  const columnComments: { table: string; column: string; text?: string }[] = []
  const definitions = clean.replace(/(^|;)\s*COMMENT\s+ON\s+COLUMN\s+"?(\w+)"?\s*\.\s*"?(\w+)"?\s+IS\s+(?:E'((?:\\[\s\S]|''|[^'\\])*)'|'((?:''|[^'])*)'|NULL)\s*(?=;|$)/gi,
    (_statement, prefix: string, table: string, column: string, escaped?: string, literal?: string) => {
      const value = escaped === undefined
        ? literal?.replace(/''/g, "'")
        : escaped.replace(/''|\\([\s\S])/g, (part, char: string) =>
          part === "''" ? "'" : (COMMENT_ESCAPES[char] ?? char))
      columnComments.push({ table, column, text: value || undefined })
      return prefix
    })

  const createRegex = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"']?(\w+)[`"']?\s*\(([^;]+)\)/gi
  let m: RegExpExecArray | null

  while ((m = createRegex.exec(definitions)) !== null) {
    const name = m[1]
    const body = m[2]
    const columns: Column[] = []
    const fkMap: Record<string, { table: string; column: string }> = {}

    // parse FOREIGN KEY constraints first
    const fkRegex = /FOREIGN\s+KEY\s*\(([^)]+)\)\s*REFERENCES\s+[`"']?(\w+)[`"']?\s*\(([^)]+)\)/gi
    let fk: RegExpExecArray | null
    while ((fk = fkRegex.exec(body)) !== null) {
      const col = fk[1].replace(/[`"']/g, '').trim()
      fkMap[col] = { table: fk[2], column: fk[3].replace(/[`"']/g, '').trim() }
    }

    const pkInline: string[] = []
    const pkConstraint = body.match(/PRIMARY\s+KEY\s*\(([^)]+)\)/i)
    if (pkConstraint) {
      pkConstraint[1].split(',').forEach(c => pkInline.push(c.replace(/[`"']/g, '').trim()))
    }

    for (const rawLine of splitTopLevel(body, /,/)) {
      const line = rawLine.trim()
      if (!line) continue
      if (/^(PRIMARY|FOREIGN|UNIQUE\s+KEY|KEY|INDEX|CONSTRAINT)\s/i.test(line)) continue

      const colMatch = line.match(/^[`"']?(\w+)[`"']?\s+(.+)$/s)
      if (!colMatch) continue

      const [, colName, definition] = colMatch
      const tokens = splitTopLevel(definition, /\s/).filter(Boolean)
      const constraintIndex = tokens.findIndex((token, index) => index > 0 && COLUMN_CONSTRAINT.test(token))
      const typeTokens = constraintIndex < 0 ? tokens : tokens.slice(0, constraintIndex)
      const constraints = constraintIndex < 0 ? '' : tokens.slice(constraintIndex).join(' ')
      const colType = typeTokens.join(' ').replace(/^[\w ]+/, name => name.toLowerCase())

      // inline REFERENCES: col_name TYPE REFERENCES other_table(other_col)
      const inlineRef = constraints.match(/REFERENCES\s+[`"']?(\w+)[`"']?\s*\(([^)]+)\)/i)
      if (inlineRef) {
        fkMap[colName] = { table: inlineRef[1], column: inlineRef[2].replace(/[`"']/g, '').trim() }
      }

      const isPK = /\bPRIMARY KEY\b/i.test(constraints) || pkInline.includes(colName)
      const col: Column = {
        name: colName,
        type: colType,
        primaryKey: isPK,
        nullable: !isPK && !/\bNOT NULL\b/i.test(constraints),
        unique: /\bUNIQUE\b/i.test(constraints),
        foreignKey: fkMap[colName],
      }
      columns.push(col)
    }

    columns.sort((a, b) => {
      const rank = (c: Column) => c.primaryKey ? 0 : c.foreignKey ? 1 : 2
      return rank(a) - rank(b)
    })

    const entry: Table = { name, columns }
    if (tagsMap[name]) entry.tags = tagsMap[name]
    tables.push(entry)
  }

  // ALTER TABLE ... ADD [CONSTRAINT ...] FOREIGN KEY (...) REFERENCES ...(...)
  const tableByName = new Map(tables.map(t => [t.name, t]))
  const alterRe = /ALTER\s+TABLE\s+[`"']?(\w+)[`"']?\s+ADD\s+(?:CONSTRAINT\s+[`"']?\w+[`"']?\s+)?FOREIGN\s+KEY\s*\(([^)]+)\)\s*REFERENCES\s+[`"']?(\w+)[`"']?\s*\(([^)]+)\)/gi
  let a: RegExpExecArray | null
  while ((a = alterRe.exec(definitions)) !== null) {
    const colName = a[2].replace(/[`"']/g, '').trim()
    const col = tableByName.get(a[1])?.columns.find(c => c.name === colName)
    if (col) col.foreignKey = { table: a[3], column: a[4].replace(/[`"']/g, '').trim() }
  }

  for (const { table, column, text } of columnComments) {
    const field = tableByName.get(table)?.columns.find(c => c.name === column)
    if (field) field.comment = text
  }

  // re-sort now that ALTER-added FKs are in place (PK → FK → rest)
  const rank = (c: Column) => c.primaryKey ? 0 : c.foreignKey ? 1 : 2
  for (const t of tables) t.columns.sort((x, y) => rank(x) - rank(y))

  return { tables }
}

// map non-Postgres type names (from MySQL / ORM imports) to Postgres equivalents
const PG_TYPE_MAP: Record<string, string> = {
  datetime: 'timestamp', double: 'double precision', number: 'numeric',
  tinyint: 'smallint', mediumint: 'integer', year: 'integer',
  string: 'text', tinytext: 'text', mediumtext: 'text', longtext: 'text', clob: 'text',
  nvarchar: 'varchar', nchar: 'char',
  blob: 'bytea', binary: 'bytea', varbinary: 'bytea',
  tinyblob: 'bytea', mediumblob: 'bytea', longblob: 'bytea',
  enum: 'text', set: 'text', array: 'text',
  citext: 'text', hstore: 'text', geometry: 'text', geography: 'text',
}
const KEEP_PARAMS = new Set(['numeric', 'varchar', 'char'])

function pgType(raw: string): string {
  const m = /^([A-Za-z_]+)\s*(\(.*\))?$/.exec(raw.trim())
  if (!m) return raw.toUpperCase()
  const base = m[1].toLowerCase()
  const mapped = PG_TYPE_MAP[base]
  if (!mapped) return raw.toUpperCase()                       // already valid / custom
  return (KEEP_PARAMS.has(mapped) ? mapped + (m[2] ?? '') : mapped).toUpperCase()
}

export function exportSQL(schema: Schema): string {
  const blocks: string[] = []

  for (const table of schema.tables) {
    const parts: string[] = []
    if (table.tags && table.tags.length > 0) {
      parts.push(`-- @tags: ${table.tags.join(', ')}`)
    }

    const colLines: string[] = []
    for (const col of table.columns) {
      let line = `  "${col.name}" ${pgType(col.type)}`
      if (!col.nullable) line += ' NOT NULL'
      if (col.unique && !col.primaryKey) line += ' UNIQUE'
      if (col.primaryKey && !table.columns.some(c => c !== col && c.primaryKey)) {
        line += ' PRIMARY KEY'
      }
      colLines.push(line)
    }

    // composite PK, if more than one PK column
    const pks = table.columns.filter(c => c.primaryKey).map(c => `"${c.name}"`)
    if (pks.length > 1) colLines.push(`  PRIMARY KEY (${pks.join(', ')})`)

    parts.push(colLines.length
      ? `CREATE TABLE "${table.name}" (\n${colLines.join(',\n')}\n);`
      : `CREATE TABLE "${table.name}" ();`)
    blocks.push(parts.join('\n'))
  }

  // Foreign keys as ALTER TABLE after every table exists — valid regardless of
  // declaration order and cyclic references.
  const fks: string[] = []
  for (const table of schema.tables) {
    for (const col of table.columns) {
      if (col.foreignKey) {
        fks.push(`ALTER TABLE "${table.name}" ADD FOREIGN KEY ("${col.name}") REFERENCES "${col.foreignKey.table}" ("${col.foreignKey.column}");`)
      }
    }
  }

  const comments = schema.tables.flatMap(table => table.columns.flatMap(col => {
    if (!col.comment) return []
    const tableName = table.name.replace(/"/g, '""')
    const columnName = col.name.replace(/"/g, '""')
    const value = col.comment.replace(/\\/g, '\\\\').replace(/'/g, "''")
    return [`COMMENT ON COLUMN "${tableName}"."${columnName}" IS E'${value}';`]
  }))
  return [blocks.join('\n\n'), fks.join('\n'), comments.join('\n')].filter(Boolean).join('\n\n') + '\n'
}
