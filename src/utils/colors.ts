import type { Table } from '../types/schema'

export const PALETTE = [
  '#6366f1', '#ec4899', '#14b8a6', '#f59e0b',
  '#ef4444', '#8b5cf6', '#06b6d4', '#10b981',
  '#f97316', '#3b82f6', '#84cc16', '#a855f7',
]

const NEUTRAL = '#4b5563'

export function tableColor(name: string): string {
  let hash = 0
  for (let i = 0; i < name.length; i++) {
    hash = (hash * 31 + name.charCodeAt(i)) >>> 0
  }
  return PALETTE[hash % PALETTE.length]
}

export function tagColor(tags: string[] | undefined): string {
  if (!tags || tags.length === 0) return NEUTRAL
  return tableColor(tags[0])
}

// A table's accent color everywhere it's drawn (card, sidebar, minimap, its
// edges' endpoints): the manual override if one was picked, else the
// tag-derived default.
export function tableAccent(table: Pick<Table, 'tags' | 'color'>): string {
  return table.color ?? tagColor(table.tags)
}
