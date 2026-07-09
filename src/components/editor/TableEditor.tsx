import { useState } from 'react'
import type { Table, Column, Schema, TableType } from '../../types/schema'
import { tableColor, tagColor } from '../../utils/colors'
import { T, type Lang } from '../../i18n'
import { useDialog } from '../../contexts/DialogContext'
import { FKPicker } from './FKPicker'
import styles from './TableEditor.module.css'

const COMMON_TYPES = [
  'integer', 'bigint', 'smallint', 'serial', 'bigserial',
  'varchar', 'text', 'char', 'uuid',
  'boolean',
  'float', 'double precision', 'decimal', 'numeric', 'real',
  'date', 'datetime', 'timestamp', 'timestamptz', 'time',
  'json', 'jsonb', 'binary', 'blob', 'bytea',
  'enum', 'array',
]

function emptyCol(): Column {
  return { name: '', type: 'varchar', nullable: true }
}

// architectural role options, shown in the editor's Type selector
const TABLE_TYPES: { value: TableType; en: string; ru: string }[] = [
  { value: 'reference',   en: 'Reference',     ru: 'Справочник' },
  { value: 'master',      en: 'Master',        ru: 'Мастер-данные' },
  { value: 'transaction', en: 'Transactional', ru: 'Транзакционная' },
  { value: 'link',        en: 'Link (M:N)',    ru: 'Связка (M:N)' },
  { value: 'dimension',   en: 'Dimension',     ru: 'Измерение' },
  { value: 'fact',        en: 'Fact',          ru: 'Факт' },
]

function Checkbox({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      onClick={() => onChange(!checked)}
      className={styles.checkboxBtn}
      style={{
        '--cb-bg': checked ? '#6366f1' : 'transparent',
        '--cb-border': checked ? '#6366f1' : 'rgba(255,255,255,0.15)',
      } as React.CSSProperties}
    >
      {checked && (
        <svg width="11" height="9" viewBox="0 0 11 9" fill="none">
          <path d="M1 4L4 7.5L10 1" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )}
    </button>
  )
}

interface Props {
  table: Table | null
  schema: Schema
  lang: Lang
  onSave: (updated: Table, originalName: string | null) => void
  onClose: () => void
}

export function TableEditor({ table, schema, lang, onSave, onClose }: Props) {
  const t = T[lang]
  const dialog = useDialog()
  const isNew = table === null
  const [name, setName] = useState(table?.name ?? '')
  const [columns, setColumns] = useState<Column[]>(
    table ? [...table.columns] : [{ name: 'id', type: 'integer', primaryKey: true, nullable: false }]
  )
  const [nameError, setNameError] = useState('')
  const [tags, setTags] = useState<string[]>(table?.tags ?? [])
  const [tableType, setTableType] = useState<TableType | ''>(table?.type ?? '')
  const [tagInput, setTagInput] = useState('')
  const [isDirty, setIsDirty] = useState(false)
  const [fkPickerRow, setFkPickerRow] = useState<number | null>(null)

  const handleClose = async () => {
    if (isDirty) {
      const ok = await dialog.confirm(
        lang === 'ru' ? 'Несохраненные изменения' : 'Unsaved changes',
        lang === 'ru' ? 'Выйти без сохранения изменений?' : 'Discard unsaved changes?'
      )
      if (!ok) return
    }
    onClose()
  }

  const accent = tagColor(tags.length > 0 ? tags : undefined)

  const updateCol = (i: number, patch: Partial<Column>) => {
    setColumns(cols => cols.map((c, idx) => idx === i ? { ...c, ...patch } : c))
    setIsDirty(true)
  }
  const deleteCol = (i: number) => {
    setColumns(cols => cols.filter((_, idx) => idx !== i))
    setIsDirty(true)
  }
  const moveUp = (i: number) => {
    if (i === 0) return
    setColumns(cols => { const n = [...cols]; [n[i-1], n[i]] = [n[i], n[i-1]]; return n })
    setIsDirty(true)
  }
  const moveDown = (i: number) => {
    setColumns(cols => {
      if (i >= cols.length - 1) return cols
      const n = [...cols]; [n[i], n[i+1]] = [n[i+1], n[i]]; return n
    })
    setIsDirty(true)
  }

  const save = () => {
    const trimmedName = name.trim()
    const finalTags = [...tags]
    const pendingTag = tagInput.trim().toLowerCase().replace(/\s+/g, '_')
    if (pendingTag && !finalTags.includes(pendingTag)) finalTags.push(pendingTag)

    if (!trimmedName) { setNameError(t.tableName + ' required'); return }
    const nameConflict = schema.tables.find(tb => tb.name === trimmedName && tb.name !== table?.name)
    if (nameConflict) { setNameError('Already exists'); return }

    const saved: Table = { name: trimmedName, columns, tags: finalTags }
    if (tableType) saved.type = tableType
    onSave(saved, isNew ? null : table!.name)
  }

  const otherTables = schema.tables.filter(tb => tb.name !== (table?.name ?? ''))

  return (
    <div className={styles.overlay} onClick={handleClose}>
      <div
        className={styles.modal}
        style={{ '--accent': accent } as React.CSSProperties}
        onClick={e => e.stopPropagation()}
      >
        <div className={styles.header}>
          <div className={styles.headerLeft}>
            <span className={styles.headerLabel}>
              {isNew ? t.createTable : t.editTable}
            </span>
            <input
              className={styles.nameInput}
              value={name}
              onChange={e => { setName(e.target.value); setNameError(''); setIsDirty(true) }}
              placeholder="table_name"
              autoFocus={isNew}
            />
            {nameError && <span className={styles.nameError}>{nameError}</span>}
          </div>
          <button onClick={handleClose} className={styles.closeBtn}>×</button>
        </div>

        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <colgroup>
              <col className={styles.col22} />
              <col className={styles.col16} />
              <col className={styles.col7} />
              <col className={styles.col7} />
              <col className={styles.col7} />
              <col className={styles.col7} />
              <col className={styles.col22} />
              <col className={styles.col12} />
            </colgroup>
            <thead className={styles.thead}>
              <tr>
                {[t.colName, t.type, 'PK', 'NN', 'UQ', 'AI', t.foreignKey, ''].map((h, i) => (
                  <th
                    key={i}
                    className={`${styles.th} ${i >= 2 && i <= 5 ? styles.thCenter : ''}`}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {columns.map((col, i) => (
                <tr key={i} className={styles.row}>
                  <td className={styles.td}>
                    <input
                      className={styles.cellInput}
                      value={col.name}
                      onChange={e => updateCol(i, { name: e.target.value })}
                      placeholder="column_name"
                    />
                  </td>
                  <td className={styles.td}>
                    <select
                      className={styles.cellSelect}
                      value={COMMON_TYPES.includes(col.type) ? col.type : '__custom__'}
                      onChange={e => { if (e.target.value !== '__custom__') updateCol(i, { type: e.target.value }) }}
                    >
                      {COMMON_TYPES.map(tp => <option key={tp} value={tp}>{tp}</option>)}
                      {!COMMON_TYPES.includes(col.type) && <option value="__custom__">{col.type}</option>}
                    </select>
                  </td>
                  <td className={styles.tdCenter}>
                    <div className={styles.checkboxCenter}>
                      <Checkbox checked={!!col.primaryKey} onChange={v => updateCol(i, { primaryKey: v, nullable: v ? false : col.nullable })} />
                    </div>
                  </td>
                  <td className={styles.tdCenter}>
                    <div className={styles.checkboxCenter}>
                      <Checkbox checked={!col.nullable} onChange={v => updateCol(i, { nullable: !v })} />
                    </div>
                  </td>
                  <td className={styles.tdCenter}>
                    <div className={styles.checkboxCenter}>
                      <Checkbox checked={!!col.unique} onChange={v => updateCol(i, { unique: v })} />
                    </div>
                  </td>
                  <td className={styles.tdCenter}>
                    <div className={styles.checkboxCenter}>
                      <Checkbox checked={col.type === 'serial' || col.type === 'bigserial'} onChange={v => updateCol(i, { type: v ? 'serial' : 'integer' })} />
                    </div>
                  </td>
                  <td className={styles.td}>
                    <button onClick={() => setFkPickerRow(i)} className={styles.fkBtn}>
                      {col.foreignKey ? (
                        <>
                          <span className={styles.fkTable} style={{ color: tableColor(col.foreignKey.table) }}>
                            {col.foreignKey.table}
                          </span>
                          <span className={styles.fkDot}>.</span>
                          <span className={styles.fkCol}>{col.foreignKey.column}</span>
                        </>
                      ) : (
                        <span className={styles.fkEmpty}>Link →</span>
                      )}
                    </button>
                    {fkPickerRow === i && (
                      <FKPicker
                        tables={otherTables}
                        value={col.foreignKey}
                        onChange={fk => { updateCol(i, { foreignKey: fk }); setFkPickerRow(null) }}
                        onClose={() => setFkPickerRow(null)}
                      />
                    )}
                  </td>
                  <td className={styles.td}>
                    <div className={styles.rowActions}>
                      <button onClick={() => moveUp(i)} className={styles.rowActionBtn}>↑</button>
                      <button onClick={() => moveDown(i)} className={styles.rowActionBtn}>↓</button>
                      <button onClick={() => deleteCol(i)} className={styles.rowDeleteBtn}>✕</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className={styles.addColSection}>
          <button
            onClick={() => { setColumns(c => [...c, emptyCol()]); setIsDirty(true) }}
            className={styles.addColBtn}
          >
            {t.addColumn}
          </button>
        </div>

        <div className={styles.tagsSection}>
          <div className={styles.tagsRow}>
            <span className={styles.tagsLabel}>{lang === 'ru' ? 'Тип:' : 'Type:'}</span>
            <select
              className={styles.typeSelect}
              value={tableType}
              onChange={e => { setTableType(e.target.value as TableType | ''); setIsDirty(true) }}
            >
              <option value="">{lang === 'ru' ? '— не задан —' : '— none —'}</option>
              {TABLE_TYPES.map(tt => (
                <option key={tt.value} value={tt.value}>{lang === 'ru' ? tt.ru : tt.en}</option>
              ))}
            </select>
          </div>
          <div className={styles.tagsRow}>
            <span className={styles.tagsLabel}>Tags:</span>
            {tags.map(tag => (
              <span key={tag} className={styles.tagChip}>
                {tag}
                <button
                  onClick={() => { setTags(ts => ts.filter(t => t !== tag)); setIsDirty(true) }}
                  className={styles.tagRemoveBtn}
                >×</button>
              </span>
            ))}
            <input
              value={tagInput}
              onChange={e => setTagInput(e.target.value)}
              onKeyDown={e => {
                if (e.key !== 'Enter') return
                e.preventDefault()
                e.stopPropagation()
                const v = tagInput.trim().toLowerCase().replace(/\s+/g, '_')
                if (v && !tags.includes(v)) { setTags(ts => [...ts, v]); setIsDirty(true) }
                setTagInput('')
              }}
              placeholder="add tag…"
              className={styles.tagInput}
            />
            <button
              type="button"
              onClick={e => {
                e.stopPropagation()
                const v = tagInput.trim().toLowerCase().replace(/\s+/g, '_')
                if (v && !tags.includes(v)) { setTags(ts => [...ts, v]); setIsDirty(true) }
                setTagInput('')
              }}
              className={styles.tagAddBtn}
            >+</button>
          </div>
        </div>

        <div className={styles.legend}>{t.legend}</div>

        <div className={styles.footer}>
          <button onClick={handleClose} className={styles.cancelBtn}>{t.cancel}</button>
          <button onClick={save} className={styles.saveBtn}>{isNew ? t.create : t.save}</button>
        </div>
      </div>
    </div>
  )
}
