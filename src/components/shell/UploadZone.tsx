import { useState, useCallback } from 'react'
import { parseSchema, detectParser, type ParserType } from '../../utils/parsers'
import { openFilePicker, getHandleFromDrop, supportsFileSystemAccess } from '../../utils/fileAccess'
import { getSaves, deleteDB, type SavedDB } from '../../utils/storage'
import { tableColor } from '../../utils/colors'
import { T, type Lang } from '../../i18n'
import type { Schema } from '../../types/schema'
import { Logo } from '../ui/Logo'
import { ThemeSwitch } from '../ui/ThemeSwitch'
import styles from './UploadZone.module.css'

export interface OpenResult {
  schema: Schema
  fileHandle?: FileSystemFileHandle
  positions?: Record<string, { x: number; y: number }>
  saveId?: string
  saveName?: string
}

interface Props {
  lang: Lang
  theme: 'dark' | 'light'
  onThemeToggle: () => void
  onOpen: (result: OpenResult) => void
}

function fmtDate(iso: string, lang: Lang) {
  return new Date(iso).toLocaleString(lang === 'ru' ? 'ru-RU' : 'en-US', {
    day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  })
}

export function UploadZone({ lang, theme, onThemeToggle, onOpen }: Props) {
  const t = T[lang]
  const [parserType, setParserType] = useState<ParserType>('json')
  const [error, setError] = useState('')
  const [dragging, setDragging] = useState(false)
  const [saves, setSaves] = useState<SavedDB[]>(() => getSaves())
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const hasFileAccess = supportsFileSystemAccess()

  const handleDeleteSave = (id: string) => {
    if (confirmDeleteId === id) {
      deleteDB(id)
      setSaves(s => s.filter(x => x.id !== id))
      setConfirmDeleteId(null)
    } else {
      setConfirmDeleteId(id)
      setTimeout(() => setConfirmDeleteId(prev => prev === id ? null : prev), 3000)
    }
  }

  const processText = useCallback(async (content: string, type: ParserType, handle?: FileSystemFileHandle) => {
    try {
      const schema = parseSchema(content, type)
      if (!schema.tables.length) throw new Error('No tables found')
      setError('')
      onOpen({ schema, fileHandle: handle })
    } catch (e) {
      setError((e as Error).message)
    }
  }, [onOpen])

  const startNewProject = useCallback(() => {
    onOpen({ schema: { tables: [] } })
  }, [onOpen])

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

  return (
    <div className={styles.root}>
      <div className={styles.nav}>
        <div className={styles.navBrand}>
          <Logo size={22} />
          <span className={styles.navLogo}>TraVis</span>
        </div>
        <div className={styles.navRight}>
          <ThemeSwitch theme={theme} onToggle={onThemeToggle} />
        </div>
      </div>

      <div className={`${styles.body} ${saves.length > 0 ? styles.bodyTwoCol : ''}`}>
        <div className={`${styles.leftCol} ${saves.length > 0 ? styles.leftColShared : ''}`}>
          <div>
            <h2 className={styles.heading}>Open schema</h2>
            <p className={styles.subheading}>Upload an existing schema file, or start a new project</p>
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

          {error && <div className={styles.error}>{error}</div>}

          <div className={styles.divider}>or</div>

          <button onClick={startNewProject} className={`${styles.visualizeBtn} ${styles.visualizeBtnActive}`}>
            Start new project →
          </button>
        </div>

        {saves.length > 0 && (
          <div className={styles.rightCol}>
            <div>
              <h2 className={styles.heading}>{t.savedSchemas}</h2>
            </div>

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
                      <span className={styles.saveDate}>{fmtDate(save.savedAt, lang)}</span>
                      <button
                        onClick={() => onOpen({ schema: save.schema, positions: save.positions, saveId: save.id, saveName: save.name })}
                        className={styles.openBtn}
                      >
                        {t.open}
                      </button>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
