import type { Column } from '../types/schema'

export function isForeignKeyTarget(column: Column): boolean {
  return Boolean(column.primaryKey || column.unique)
}
