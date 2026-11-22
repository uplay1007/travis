import { useState } from 'react'
import { tableAccent } from '../../utils/colors'
import type { Table } from '../../types/schema'
import { T, type Lang } from '../../i18n'
import styles from './Sidebar.module.css'

export const SIDEBAR_W = 300

interface Props {
  tables: Table[]
  lang: Lang
  readOnly: boolean
  onLangToggle: () => void
  onNew: () => void
  onEdit: (table: Table) => void
  onDelete: (tableName: string) => void
}

export function Sidebar({ tables, lang, readOnly, onLangToggle, onNew, onEdit, onDelete }: Props) {
  const t = T[lang]
  const [search, setSearch] = useState('')
  const filtered = search.trim()
    ? tables.filter(t => t.name.toLowerCase().includes(search.toLowerCase()))
    : tables

  return (
    <div className={styles.sidebar}>
      <div className={styles.newBtnWrap}>
        <button onClick={onNew} disabled={readOnly} className={styles.newBtn}>
          {t.newTable}
        </button>
      </div>

      <div className={styles.countRow}>
        <span className={styles.countLabel}>Tables</span>
        <span className={styles.countValue}>{tables.length}</span>
      </div>

      {tables.length > 8 && (
        <div className={styles.searchWrap}>
          <input
            className={styles.searchInput}
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search tables…"
          />
        </div>
      )}

      <div className={styles.list}>
        {filtered.map(table => {
          const color = tableAccent(table)
          return (
            <div key={table.name} className={styles.tableItem}>
              <span
                className={styles.dot}
                style={{ '--dot-color': color, '--dot-glow': `${color}88` } as React.CSSProperties}
              />

              <div className={styles.nameCol}>
                <span className={styles.tableName} onClick={readOnly ? undefined : () => onEdit(table)}>
                  {table.name}
                </span>
                {table.tags && table.tags.length > 0 && (
                  <div className={styles.tagList}>
                    {table.tags.map(tag => (
                      <span key={tag} className={styles.tag}>#{tag}</span>
                    ))}
                  </div>
                )}
              </div>

              <span className={styles.colCount}>{table.columns.length}</span>

              <div className={styles.actions}>
                <button onClick={() => onEdit(table)} disabled={readOnly} className={styles.editBtn} title="Edit">✏️</button>
                <button onClick={() => onDelete(table.name)} disabled={readOnly} className={styles.deleteBtn} title="Delete">🗑️</button>
              </div>
            </div>
          )
        })}
      </div>

    </div>
  )
}
