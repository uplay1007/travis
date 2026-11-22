import type { Schema } from '../../types/schema'
import { isStructuredSchema, structuredToSchema } from '../structuredJSON'

export function parseJSON(text: string): Schema {
  const raw = JSON.parse(text)

  // public format: { Tables, Relations, Layouts, Groups }
  if (isStructuredSchema(raw)) return structuredToSchema(raw)

  // legacy internal format: { tables: [...] }
  if (!Array.isArray(raw.tables)) throw new Error('Expected { Tables: [] } or { tables: [] }')
  for (const t of raw.tables) {
    if (typeof t.name !== 'string' || !t.name) throw new Error(`Table missing name`)
    if (!Array.isArray(t.columns)) throw new Error(`Table "${t.name}" missing columns array`)
    for (const c of t.columns) {
      if (typeof c.name !== 'string' || !c.name) throw new Error(`Column in "${t.name}" missing name`)
      if (typeof c.type !== 'string' || !c.type) throw new Error(`Column "${c.name}" in "${t.name}" missing type`)
      if (typeof c.comment !== 'string') delete c.comment
    }
  }
  return raw as Schema
}
