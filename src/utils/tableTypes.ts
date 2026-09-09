import type { TableType } from '../types/schema'

// The architectural roles a table can be tagged with, in the order they're
// offered in the editor and listed in the canvas' type filter.
export const TABLE_TYPES: { value: TableType; en: string; ru: string }[] = [
  { value: 'reference',   en: 'Reference',     ru: 'Справочник' },
  { value: 'master',      en: 'Master',        ru: 'Мастер-данные' },
  { value: 'transaction', en: 'Transactional', ru: 'Транзакционная' },
  { value: 'link',        en: 'Link (M:N)',    ru: 'Связка (M:N)' },
  { value: 'dimension',   en: 'Dimension',     ru: 'Измерение' },
  { value: 'fact',        en: 'Fact',          ru: 'Факт' },
]
