import { useState, useCallback, useEffect } from 'react'
import { parseSchema, detectParser, type ParserType } from '../../utils/parsers'
import { openFilePicker, getHandleFromDrop, supportsFileSystemAccess } from '../../utils/fileAccess'
import { fetchSaves, deleteSave, type RemoteSave } from '../../services/schemasAPI'
import { useAuth } from '../../contexts/AuthContext'
import type { Schema } from '../../types/schema'
import { T, type Lang } from '../../i18n'
import { tableColor } from '../../utils/colors'
import { useDialog } from '../../contexts/DialogContext'
import { Logo } from '../ui/Logo'
import styles from './UploadZone.module.css'

export interface OpenResult {
  schema: Schema
  fileHandle?: FileSystemFileHandle
  savedId?: string
  savedName?: string
  positions?: Record<string, { x: number; y: number }>
}

interface Props {
  lang: Lang
  onLangToggle: () => void
  onOpen: (result: OpenResult) => void
}

const PARSERS: { value: ParserType; label: string }[] = [
  { value: 'json',       label: 'Universal JSON' },
  { value: 'prisma',     label: 'Prisma'         },
  { value: 'sql',        label: 'SQL DDL'        },
  { value: 'typeorm',    label: 'TypeORM'        },
  { value: 'django',     label: 'Django'         },
  { value: 'sqlalchemy', label: 'SQLAlchemy'     },
]

function fmtDate(iso: string, lang: Lang) {
  return new Date(iso).toLocaleString(lang === 'ru' ? 'ru-RU' : 'en-US', {
    day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  })
}

export function UploadZone({ lang, onLangToggle, onOpen }: Props) {
  const t = T[lang]
  const dialog = useDialog()
  const { signOut, user } = useAuth()
  const [parserType, setParserType] = useState<ParserType>('json')
  const [text, setText] = useState('')
  const [error, setError] = useState('')
  const [dragging, setDragging] = useState(false)
  const [saves, setSaves] = useState<RemoteSave[]>([])
  const [savesLoading, setSavesLoading] = useState(true)
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const hasFileAccess = supportsFileSystemAccess()

  useEffect(() => {
    fetchSaves()
      .then(setSaves)
      .catch(() => setSaves([]))
      .finally(() => setSavesLoading(false))
  }, [])

  const processText = useCallback(async (content: string, type: ParserType, handle?: FileSystemFileHandle) => {
    try {
      const schema = parseSchema(content, type)
      if (!schema.tables.length) throw new Error('No tables found')

      const fileName = handle?.name.replace(/\.[^.]+$/, '')
      const existing = fileName ? saves.find(s => s.name === fileName) : undefined

      if (existing) {
        const ok = await dialog.confirm(
          lang === 'ru' ? 'Проект уже существует' : 'Project already exists',
          lang === 'ru'
            ? `Проект "${existing.name}" уже есть в ваших сохранениях. Импорт этого файла НЕ обновит кастомные теги и расстановку из сохранения. Продолжить как новую БД?`
            : `Project "${existing.name}" is already in your saves. Importing this file will NOT apply your custom tags and layout from the save. Import as a new DB anyway?`
        )
        if (!ok) return
      }

      setError('')
      onOpen({ schema, fileHandle: handle })
    } catch (e) {
      setError((e as Error).message)
    }
  }, [onOpen, saves, lang, dialog])

  const handleOpenClick = useCallback(async () => {
    if (hasFileAccess) {
      const result = await openFilePicker(['.json', '.prisma', '.sql', '.ts', '.py'])
      if (!result) return
      const content = await result.file.text()
      const type = detectParser(result.file.name, content)
      setParserType(type)
      processText(content, type, result.handle)
    } else {
      document.getElementById('file-input-fallback')?.click()
    }
  }, [hasFileAccess, processText])

  const onFileFallback = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]; if (!file) return
    file.text().then(c => { const type = detectParser(file.name, c); setParserType(type); processText(c, type) })
    e.target.value = ''
  }, [processText])

  const onDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault(); setDragging(false)
    const handle = await getHandleFromDrop(e)
    if (handle) {
      const file = await handle.getFile()
      const content = await file.text()
      const type = detectParser(file.name, content)
      setParserType(type)
      processText(content, type, handle)
    } else {
      const file = e.dataTransfer.files[0]; if (!file) return
      file.text().then(c => { const type = detectParser(file.name, c); setParserType(type); processText(c, type) })
    }
  }, [processText])

  const handleDeleteSave = (id: string) => {
    if (confirmDeleteId === id) {
      deleteSave(id)
        .then(() => setSaves(s => s.filter(x => x.id !== id)))
        .catch(() => {})
      setConfirmDeleteId(null)
    } else {
      setConfirmDeleteId(id)
      setTimeout(() => setConfirmDeleteId(prev => prev === id ? null : prev), 3000)
    }
  }

  return (
    <div className={styles.root}>
      <div className={styles.nav}>
        <div className={styles.navBrand}>
          <Logo size={22} />
          <span className={styles.navLogo}>TraVis</span>
        </div>
        <div className={styles.navRight}>
          <span className={styles.navEmail}>{user?.email}</span>
          <button onClick={signOut} className={styles.signOutBtn}>Sign out</button>
          <button onClick={onLangToggle} className={styles.langBtn}>
            {lang === 'en' ? 'RU' : 'EN'}
          </button>
        </div>
      </div>

      <div className={styles.body}>
        <div className={styles.leftCol}>
          <div>
            <h2 className={styles.heading}>Open schema</h2>
            <p className={styles.subheading}>Upload or paste your database schema</p>
          </div>

          <div className={styles.parserList}>
            {PARSERS.map(p => (
              <button
                key={p.value}
                onClick={() => setParserType(p.value)}
                className={`${styles.parserBtn} ${parserType === p.value ? styles.parserBtnActive : ''}`}
              >
                {p.label}
              </button>
            ))}
          </div>

          <div
            onClick={handleOpenClick}
            onDragOver={e => { e.preventDefault(); setDragging(true) }}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
            className={`${styles.dropZone} ${dragging ? styles.dropZoneDragging : ''}`}
          >
            <input
              id="file-input-fallback"
              type="file"
              className={styles.dropZoneHiddenInput}
              onChange={onFileFallback}
              accept=".json,.prisma,.sql,.ts,.py"
            />
            <div className={styles.dropZoneIcon}>📂</div>
            <p className={styles.dropZoneText}>Drop file here or click to upload</p>
            <p className={styles.dropZoneFormats}>.json · .prisma · .sql · .ts · .py</p>
            {hasFileAccess && (
              <span className={styles.dropZoneBadge}>✓ Direct file save supported</span>
            )}
          </div>

          <div>
            <textarea
              value={text}
              onChange={e => setText(e.target.value)}
              placeholder="...or paste schema text here"
              className={styles.textarea}
            />
            <button
              onClick={() => processText(text, parserType)}
              disabled={!text.trim()}
              className={`${styles.visualizeBtn} ${text.trim() ? styles.visualizeBtnActive : styles.visualizeBtnDisabled}`}
            >
              Visualize →
            </button>
          </div>

          {error && <div className={styles.error}>{error}</div>}

          <button onClick={() => processText(DEMO_SCHEMA, 'json')} className={styles.demoBtn}>
            Load demo schema
          </button>
        </div>

        <div className={styles.rightCol}>
          <div>
            <h2 className={styles.heading}>{t.savedSchemas}</h2>
            <p className={styles.subheading}>{t.savedAt}</p>
          </div>

          {savesLoading ? (
            <div className={styles.savesLoading}>
              <span className={styles.savesLoadingText}>Loading...</span>
            </div>
          ) : saves.length === 0 ? (
            <div className={styles.savesEmpty}>
              <span className={styles.savesEmptyIcon}>🗄️</span>
              <span className={styles.savesEmptyText}>{t.noSaves}</span>
            </div>
          ) : (
            <div className={styles.savesList}>
              {saves.map(save => {
                const isConfirming = confirmDeleteId === save.id
                return (
                  <div key={save.id} className={styles.saveCard}>
                    <div className={styles.saveCardTop}>
                      <span className={styles.saveCardName}>{save.name}</span>
                      <button
                        onClick={() => handleDeleteSave(save.id)}
                        className={`${styles.saveDeleteBtn} ${isConfirming ? styles.saveDeleteBtnConfirm : ''}`}
                      >
                        {isConfirming ? (lang === 'ru' ? 'Удалить?' : 'Confirm?') : '🗑️'}
                      </button>
                    </div>
                    <div className={styles.saveTableTags}>
                      {save.schema.tables.slice(0, 6).map(tbl => (
                        <span
                          key={tbl.name}
                          className={styles.saveTableTag}
                          style={{
                            '--tag-bg': `${tableColor(tbl.name)}22`,
                            '--tag-color': tableColor(tbl.name),
                          } as React.CSSProperties}
                        >
                          {tbl.name}
                        </span>
                      ))}
                      {save.schema.tables.length > 6 && (
                        <span className={styles.saveTableTagExtra}>
                          +{save.schema.tables.length - 6}
                        </span>
                      )}
                    </div>
                    <div className={styles.saveCardBottom}>
                      <span className={styles.saveDate}>{fmtDate(save.saved_at, lang)}</span>
                      <button
                        onClick={() => onOpen({ schema: save.schema, savedId: save.id, savedName: save.name, positions: save.positions })}
                        className={styles.openBtn}
                      >
                        {t.open}
                      </button>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

const DEMO_SCHEMA = JSON.stringify({ tables: [
  { name: "users", columns: [{ name: "id", type: "integer", primaryKey: true, nullable: false }, { name: "role_id", type: "integer", nullable: false, foreignKey: { table: "roles", column: "id" } }, { name: "email", type: "varchar", nullable: false, unique: true }] },
  { name: "roles", columns: [{ name: "id", type: "integer", primaryKey: true, nullable: false }, { name: "name", type: "varchar", nullable: false, unique: true }] },
  { name: "posts", columns: [{ name: "id", type: "integer", primaryKey: true, nullable: false }, { name: "user_id", type: "integer", nullable: false, foreignKey: { table: "users", column: "id" } }, { name: "title", type: "varchar", nullable: false }] },
]}, null, 2)
