import { useEffect, useId, useRef, useState } from 'react'
import type { Table, Column, Schema, TableType } from '../../types/schema'
import { tagColor, PALETTE } from '../../utils/colors'
import { T, type Lang } from '../../i18n'
import { useDialog } from '../../contexts/DialogContext'
import { IDENT } from '../../utils/schemaDSL'
import { TABLE_TYPES } from '../../utils/tableTypes'
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

const FLAG_LABELS = {
  en: { PK: 'Primary key', NN: 'Not null', UQ: 'Unique', AI: 'Auto increment' },
  ru: { PK: 'Первичный ключ', NN: 'Не null', UQ: 'Уникальность', AI: 'Автоинкремент' },
}

function ColumnFlag({ code, label, checked, onChange }: {
  code: string
  label: string
  checked: boolean
  onChange: (checked: boolean) => void
}) {
  return (
    <td role="cell" className={styles.flagCell}>
      <label className={styles.flagControl} title={label}>
        <span className={styles.mobileLabel} aria-hidden="true">{code}</span>
        <input
          type="checkbox"
          aria-label={label}
          checked={checked}
          onChange={event => onChange(event.target.checked)}
        />
      </label>
    </td>
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
  const flagLabels = FLAG_LABELS[lang]
  const dialog = useDialog()
  const id = useId()
  const isNew = table === null
  const [name, setName] = useState(table?.name ?? '')
  const [columns, setColumns] = useState<Column[]>(
    table ? [...table.columns] : [{ name: 'id', type: 'integer', primaryKey: true, nullable: false }]
  )
  const [nameError, setNameError] = useState('')
  const [tags, setTags] = useState<string[]>(table?.tags ?? [])
  const [tableType, setTableType] = useState<TableType | ''>(table?.type ?? '')
  const [color, setColor] = useState<string | undefined>(table?.color)
  const [tagInput, setTagInput] = useState('')
  const [isDirty, setIsDirty] = useState(false)
  const [fkPickerRow, setFkPickerRow] = useState<number | null>(null)
  const nameInput = useRef<HTMLInputElement>(null)
  const lastColumnInput = useRef<HTMLInputElement>(null)
  const focusNewColumn = useRef(false)

  useEffect(() => {
    if (focusNewColumn.current) {
      lastColumnInput.current?.focus()
      focusNewColumn.current = false
    }
  }, [columns.length])

  const handleClose = async () => {
    if (isDirty || tagInput.trim()) {
      const ok = await dialog.confirm(
        lang === 'ru' ? 'Несохранённые изменения' : 'Unsaved changes',
        lang === 'ru' ? 'Выйти без сохранения изменений?' : 'Discard unsaved changes?'
      )
      if (!ok) return
    }
    onClose()
  }

  const defaultAccent = tagColor(tags)
  const accent = color ?? defaultAccent
  const pendingTag = tagInput.trim().toLowerCase().replace(/\s+/g, '_')
  const canAddTag = pendingTag.length > 0 && !tags.includes(pendingTag)

  const addTag = () => {
    if (canAddTag) {
      setTags(current => [...current, pendingTag])
      setIsDirty(true)
    }
    setTagInput('')
  }

  const addColumn = () => {
    focusNewColumn.current = true
    setColumns(current => [...current, { name: '', type: 'varchar', nullable: true }])
    setIsDirty(true)
  }

  const updateCol = (index: number, patch: Partial<Column>) => {
    setColumns(current => current.map((column, i) => i === index ? { ...column, ...patch } : column))
    setIsDirty(true)
  }

  const deleteCol = (index: number) => {
    setColumns(current => current.filter((_, i) => i !== index))
    setIsDirty(true)
  }

  const moveCol = (from: number, to: number) => {
    setColumns(current => {
      const reordered = [...current]
      reordered[from] = current[to]
      reordered[to] = current[from]
      return reordered
    })
    setIsDirty(true)
  }

  const showNameError = (message: string) => {
    setNameError(message)
    nameInput.current?.focus()
  }

  const save = () => {
    const trimmedName = name.trim()
    if (!trimmedName) {
      showNameError(lang === 'ru' ? 'Укажи имя таблицы' : 'Enter a table name')
      return
    }
    if (!IDENT.test(trimmedName)) {
      showNameError(lang === 'ru' ? 'Только латиница, цифры и _' : 'Latin letters, digits and _ only')
      return
    }
    if (schema.tables.some(entry => entry.name === trimmedName && entry.name !== table?.name)) {
      showNameError(lang === 'ru' ? 'Таблица с таким именем уже есть' : 'A table with this name already exists')
      return
    }

    const saved: Table = {
      name: trimmedName,
      columns: columns.map(column => ({ ...column, comment: column.comment?.trim() ? column.comment : undefined })),
      tags: canAddTag ? [...tags, pendingTag] : tags,
    }
    if (tableType) saved.type = tableType
    if (color) saved.color = color
    onSave(saved, table?.name ?? null)
  }

  const otherTables = schema.tables.filter(entry => entry.name !== table?.name)

  return (
    <>
      <div className={styles.overlay} onClick={handleClose}>
        <div
          role="dialog"
          aria-labelledby={`${id}-title`}
          className={styles.modal}
          style={{ '--table-accent': accent } as React.CSSProperties}
          onClick={event => event.stopPropagation()}
        >
          <header className={styles.header}>
            <div className={styles.headerTitle}>
              <span className={styles.tableAccent} aria-hidden="true" />
              <h2 id={`${id}-title`}>{isNew ? t.createTable : t.editTable}</h2>
            </div>
            <button type="button" onClick={handleClose} className={styles.closeBtn} aria-label={t.closeEditor}>×</button>
          </header>

          <div className={styles.body}>
            <div className={styles.nameField}>
              <label htmlFor={`${id}-name`}>{t.tableName}</label>
              <input
                id={`${id}-name`}
                ref={nameInput}
                className={styles.nameInput}
                value={name}
                onChange={event => { setName(event.target.value); setNameError(''); setIsDirty(true) }}
                placeholder="table_name"
                autoFocus={isNew}
                aria-invalid={nameError ? true : undefined}
                aria-describedby={nameError ? `${id}-name-error` : undefined}
              />
              {nameError && <p className={styles.nameError} id={`${id}-name-error`} role="alert">{nameError}</p>}
            </div>

            <section aria-labelledby={`${id}-columns`}>
              <div className={styles.sectionBar}>
                <h3 id={`${id}-columns`}>{t.columnsHeading}</h3>
                <button type="button" className={styles.addColumn} onClick={addColumn}>{t.addColumn}</button>
              </div>

              {columns.length === 0 ? (
                <p className={styles.emptyColumns}>{t.noColumns}</p>
              ) : (
                <div className={styles.tableWrap}>
                  <table role="table" className={styles.table}>
                    <colgroup>
                      <col />
                      <col className={styles.typeColumn} />
                      <col span={4} className={styles.flagColumn} />
                      <col className={styles.foreignKeyColumn} />
                      <col />
                      <col className={styles.actionsColumn} />
                    </colgroup>
                    <thead role="rowgroup" className={styles.thead}>
                      <tr role="row">
                        <th role="columnheader" scope="col">{t.colName}</th>
                        <th role="columnheader" scope="col">{t.type}</th>
                        {Object.entries(flagLabels).map(([code, label]) => (
                          <th role="columnheader" scope="col" key={code} title={label} className={styles.flagHeading}>{code}</th>
                        ))}
                        <th role="columnheader" scope="col">{t.foreignKey}</th>
                        <th role="columnheader" scope="col">{t.columnComment}</th>
                        <th role="columnheader" scope="col" className={styles.actionsHeading}>{t.columnActions}</th>
                      </tr>
                    </thead>
                    <tbody role="rowgroup">
                      {columns.map((column, index) => {
                        const foreignKey = column.foreignKey
                        const target = foreignKey && `${foreignKey.table}.${foreignKey.column}`
                        return (
                          <tr role="row" key={index} className={styles.row}>
                            <td role="cell" className={styles.columnField}>
                              <span className={styles.mobileLabel} aria-hidden="true">{t.colName}</span>
                              <input
                                ref={index === columns.length - 1 ? lastColumnInput : undefined}
                                className={styles.columnName}
                                value={column.name}
                                onChange={event => updateCol(index, { name: event.target.value })}
                                aria-label={`${t.colName} ${index + 1}`}
                                placeholder="column_name"
                              />
                            </td>
                            <td role="cell" className={styles.columnField}>
                              <span className={styles.mobileLabel} aria-hidden="true">{t.type}</span>
                              <div className={styles.selectField}>
                                <select
                                  aria-label={`${t.type} ${index + 1}`}
                                  value={COMMON_TYPES.includes(column.type) ? column.type : '__custom__'}
                                  onChange={event => updateCol(index, { type: event.target.value })}
                                >
                                  {!COMMON_TYPES.includes(column.type) && <option value="__custom__">{column.type}</option>}
                                  {COMMON_TYPES.map(type => <option key={type} value={type}>{type}</option>)}
                                </select>
                              </div>
                            </td>
                            <ColumnFlag code="PK" label={flagLabels.PK} checked={!!column.primaryKey} onChange={checked => updateCol(index, { primaryKey: checked, nullable: checked ? false : column.nullable })} />
                            <ColumnFlag code="NN" label={flagLabels.NN} checked={!column.nullable} onChange={checked => updateCol(index, { nullable: !checked })} />
                            <ColumnFlag code="UQ" label={flagLabels.UQ} checked={!!column.unique} onChange={checked => updateCol(index, { unique: checked })} />
                            <ColumnFlag code="AI" label={flagLabels.AI} checked={column.type === 'serial' || column.type === 'bigserial'} onChange={checked => updateCol(index, { type: checked ? 'serial' : 'integer' })} />
                            <td role="cell" className={styles.foreignKeyCell}>
                              <span className={styles.mobileLabel} aria-hidden="true">{t.foreignKey}</span>
                              <button
                                type="button"
                                aria-label={target ? `${t.foreignKey}: ${target}` : t.foreignKey}
                                title={target}
                                onClick={() => setFkPickerRow(index)}
                                className={styles.fkBtn}
                                data-linked={!!target}
                              >
                                <span>{target ?? (lang === 'ru' ? 'Связать' : 'Link')}</span>
                                <span aria-hidden="true">→</span>
                              </button>
                            </td>
                            <td role="cell" className={styles.commentCell}>
                              <span className={styles.mobileLabel} aria-hidden="true">{t.columnComment}</span>
                              <input
                                type="text"
                                aria-label={`${t.columnComment} ${index + 1}`}
                                value={column.comment ?? ''}
                                onChange={event => updateCol(index, { comment: event.target.value })}
                              />
                            </td>
                            <td role="cell" className={styles.actionsCell}>
                              <div className={styles.rowActions}>
                                <button type="button" onClick={() => moveCol(index, index - 1)} disabled={index === 0} aria-label={t.moveColumnUp} title={t.moveColumnUp}>↑</button>
                                <button type="button" onClick={() => moveCol(index, index + 1)} disabled={index === columns.length - 1} aria-label={t.moveColumnDown} title={t.moveColumnDown}>↓</button>
                                <button type="button" onClick={() => deleteCol(index)} className={styles.deleteColumn} aria-label={t.removeColumn} title={t.removeColumn}>×</button>
                              </div>
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              )}

              <p className={styles.legend}>{t.legend}</p>
            </section>

            <section className={styles.settings} aria-labelledby={`${id}-settings`}>
              <h3 id={`${id}-settings`}>{t.tableSettings}</h3>
              <div className={styles.settingsGrid}>
                <div className={styles.settingField}>
                  <label htmlFor={`${id}-role`}>{t.tableRole}</label>
                  <div className={styles.selectField}>
                    <select
                      id={`${id}-role`}
                      value={tableType}
                      onChange={event => { setTableType(event.target.value as TableType | ''); setIsDirty(true) }}
                    >
                      <option value="">{lang === 'ru' ? 'Без роли' : 'None'}</option>
                      {TABLE_TYPES.map(role => (
                        <option key={role.value} value={role.value}>{role[lang]}</option>
                      ))}
                    </select>
                  </div>
                </div>

                <div className={styles.settingField}>
                  <span id={`${id}-color`}>{t.tableColor}</span>
                  <div className={styles.swatches} role="group" aria-labelledby={`${id}-color`}>
                    <button
                      type="button"
                      onClick={() => { setColor(undefined); setIsDirty(true) }}
                      className={`${styles.swatch} ${styles.swatchAuto}`}
                      aria-pressed={color === undefined}
                      style={{ '--swatch': defaultAccent } as React.CSSProperties}
                      aria-label={lang === 'ru' ? 'Цвет по тегу' : 'Automatic color from tag'}
                    >A</button>
                    {PALETTE.map(swatch => (
                      <button
                        key={swatch}
                        type="button"
                        onClick={() => { setColor(swatch); setIsDirty(true) }}
                        className={styles.swatch}
                        aria-pressed={color === swatch}
                        style={{ '--swatch': swatch } as React.CSSProperties}
                        title={swatch}
                      />
                    ))}
                  </div>
                </div>

                <div className={`${styles.settingField} ${styles.tagField}`}>
                  <label htmlFor={`${id}-tags`}>{t.tableTags}</label>
                  <div className={styles.tags}>
                    {tags.map(tag => (
                      <span key={tag} className={styles.tag}>
                        <span>{tag}</span>
                        <button
                          type="button"
                          onClick={() => { setTags(current => current.filter(value => value !== tag)); setIsDirty(true) }}
                          aria-label={t.removeTag(tag)}
                        >×</button>
                      </span>
                    ))}
                    <div className={styles.tagEntry}>
                      <input
                        id={`${id}-tags`}
                        value={tagInput}
                        onChange={event => setTagInput(event.target.value)}
                        onKeyDown={event => {
                          if (event.key !== 'Enter') return
                          event.preventDefault()
                          event.stopPropagation()
                          addTag()
                        }}
                        placeholder={lang === 'ru' ? 'Добавить тег…' : 'Add a tag…'}
                      />
                      <button type="button" className={styles.tagAddBtn} onClick={addTag} disabled={!canAddTag} aria-label={t.addTag}>+</button>
                    </div>
                  </div>
                </div>
              </div>
            </section>
          </div>

          <footer className={styles.footer}>
            <button type="button" onClick={handleClose} className={styles.cancelBtn}>{t.cancel}</button>
            <button type="button" onClick={save} className={styles.saveBtn}>{isNew ? t.create : t.save}</button>
          </footer>
        </div>
      </div>
      {fkPickerRow !== null && columns[fkPickerRow] && (
        <FKPicker
          tables={otherTables}
          lang={lang}
          value={columns[fkPickerRow].foreignKey}
          onChange={foreignKey => updateCol(fkPickerRow, { foreignKey })}
          onClose={() => setFkPickerRow(null)}
        />
      )}
    </>
  )
}
