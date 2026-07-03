import { useState, useEffect } from 'react'
import type { Table, ForeignKey } from '../../types/schema'
import { tableColor } from '../../utils/colors'
import styles from './FKPicker.module.css'

interface Props {
  tables: Table[]
  value: ForeignKey | undefined
  onChange: (fk: ForeignKey | undefined) => void
  onClose: () => void
}

export function FKPicker({ tables, value, onChange, onClose }: Props) {
  const [selectedTable, setSelectedTable] = useState<Table | null>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (selectedTable) setSelectedTable(null)
        else onClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selectedTable, onClose])

  const handlePickColumn = (table: Table, colName: string) => {
    onChange({ table: table.name, column: colName })
    onClose()
  }

  return (
    <div
      className={styles.overlay}
      onClick={() => selectedTable ? setSelectedTable(null) : onClose()}
    >
      <div className={styles.modal} onClick={e => e.stopPropagation()}>
        <div className={styles.header}>
          <div className={styles.headerLeft}>
            {selectedTable && (
              <button onClick={() => setSelectedTable(null)} className={styles.backBtn}>
                ←
              </button>
            )}
            <span className={styles.headerTitle}>
              {selectedTable ? (
                <>
                  <span style={{ color: tableColor(selectedTable.name) }}>{selectedTable.name}</span>
                  <span className={styles.headerSub}>— pick column</span>
                </>
              ) : 'Link foreign key'}
            </span>
          </div>
          <button onClick={onClose} className={styles.closeBtn}>×</button>
        </div>

        <div className={styles.body}>
          {!selectedTable ? (
            <>
              {value && (
                <>
                  <button
                    onClick={() => { onChange(undefined); onClose() }}
                    className={styles.clearBtn}
                  >
                    <span className={styles.clearBtnIcon}>✕</span>
                    <span>Clear link</span>
                    <span className={styles.clearBtnCurrent}>{value.table}.{value.column}</span>
                  </button>
                  <div className={styles.divider} />
                </>
              )}
              {tables.map(tbl => (
                <button
                  key={tbl.name}
                  onClick={() => setSelectedTable(tbl)}
                  className={styles.tableBtn}
                >
                  <span
                    className={styles.tableBtnName}
                    style={{ color: tableColor(tbl.name) }}
                  >
                    {tbl.name}
                  </span>
                  <div className={styles.tableBtnRight}>
                    {tbl.tags?.map(tag => (
                      <span key={tag} className={styles.tag}>#{tag}</span>
                    ))}
                    <span className={styles.tableArrow}>›</span>
                  </div>
                </button>
              ))}
            </>
          ) : (
            selectedTable.columns.map(col => {
              const isSelected = value?.table === selectedTable.name && value?.column === col.name
              return (
                <button
                  key={col.name}
                  onClick={() => handlePickColumn(selectedTable, col.name)}
                  className={styles.colBtn}
                >
                  <div className={styles.colBtnLeft}>
                    <span
                      className={styles.radio}
                      style={{
                        '--radio-border': isSelected ? '#6366f1' : 'rgba(255,255,255,0.2)',
                        '--radio-bg': isSelected ? '#6366f1' : 'transparent',
                      } as React.CSSProperties}
                    >
                      {isSelected && <span className={styles.radioDot} />}
                    </span>
                    <span className={styles.colName}>{col.name}</span>
                  </div>
                  <span className={styles.colType}>{col.type}</span>
                </button>
              )
            })
          )}
        </div>
      </div>
    </div>
  )
}
