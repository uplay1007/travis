import { useRef, useState } from 'react'
import { detectParser, parseSchema, schemaFileExtensions } from '../../utils/parsers'
import { getHandleFromDrop, openFilePicker, supportsFileSystemAccess } from '../../utils/fileAccess'
import { getSaves, deleteDB, type SavedDB } from '../../utils/storage'
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
  const fileInput = useRef<HTMLInputElement>(null)
  const [error, setError] = useState('')
  const [dragging, setDragging] = useState(false)
  const [isOpening, setIsOpening] = useState(false)
  const [saves, setSaves] = useState<SavedDB[]>(getSaves)
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)

  const handleDeleteSave = (id: string) => {
    if (confirmDeleteId === id) {
      deleteDB(id)
      setSaves(current => current.filter(save => save.id !== id))
      setConfirmDeleteId(null)
    } else {
      setConfirmDeleteId(id)
      setTimeout(() => setConfirmDeleteId(current => current === id ? null : current), 3000)
    }
  }

  const openSchema = async (file?: File, handleRequest?: Promise<FileSystemFileHandle | null>) => {
    setError('')
    setIsOpening(true)
    try {
      const handle = await handleRequest
      if (!file) file = await handle?.getFile()
      if (!file) return
      const content = await file.text()
      const schema = parseSchema(content, detectParser(file.name, content))
      if (!schema.tables.length) throw new Error(t.noTablesFound)
      onOpen({ schema, fileHandle: handle ?? undefined })
    } catch (error) {
      setError(error instanceof Error ? error.message : t.fileReadError)
    } finally {
      setIsOpening(false)
    }
  }

  const handleOpenClick = async () => {
    if (supportsFileSystemAccess()) {
      try {
        const handle = await openFilePicker(schemaFileExtensions)
        if (handle) await openSchema(undefined, Promise.resolve(handle))
        return
      } catch {
        // Some browsers expose the native picker but block it in embedded pages.
      }
    }
    fileInput.current?.click()
  }

  const onDrop = (event: React.DragEvent<HTMLButtonElement>) => {
    event.preventDefault()
    setDragging(false)
    if (isOpening) return
    // The browser releases the drag data store as soon as this event returns.
    const file = event.dataTransfer.files[0]
    if (file) void openSchema(file, getHandleFromDrop(event))
  }

  return (
    <div className={styles.root}>
      <header className={styles.nav}>
        <div className={styles.navBrand}>
          <Logo size={22} />
          <span>TraVis</span>
        </div>
        <ThemeSwitch theme={theme} onToggle={onThemeToggle} />
      </header>

      <main className={styles.body}>
        <h1 className={styles.heading}>{t.startHeading}</h1>

        <div className={styles.actions}>
          <button
            type="button"
            className={`${styles.action} ${styles.createAction}`}
            onClick={() => onOpen({ schema: { tables: [] } })}
            disabled={isOpening}
            aria-labelledby="create-schema-title"
            aria-describedby="create-schema-hint"
          >
            <span className={`${styles.actionIcon} ${styles.createIcon}`} aria-hidden="true">+</span>
            <span className={styles.actionArrow} aria-hidden="true">→</span>
            <span id="create-schema-title" className={styles.actionTitle}>{t.createSchema}</span>
            <span id="create-schema-hint" className={styles.actionHint}>{t.createSchemaHint}</span>
          </button>

          <button
            type="button"
            className={`${styles.action} ${dragging ? styles.dropActive : ''}`}
            onClick={handleOpenClick}
            onDragOver={event => {
              event.preventDefault()
              if (!isOpening) setDragging(true)
            }}
            onDragLeave={event => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false)
            }}
            onDrop={onDrop}
            disabled={isOpening}
            aria-labelledby="open-schema-title"
            aria-describedby="open-schema-hint open-schema-formats"
          >
            <span className={`${styles.actionIcon} ${styles.fileIcon}`} aria-hidden="true" />
            <span className={styles.actionArrow} aria-hidden="true">→</span>
            <span id="open-schema-title" className={styles.actionTitle}>{t.openSchema}</span>
            <span id="open-schema-hint" className={styles.actionHint}>{t.openSchemaHint}</span>
            <span id="open-schema-formats" className={styles.formats}>
              {schemaFileExtensions.map(extension => <span key={extension}>{extension}</span>)}
            </span>
          </button>

          <input
            ref={fileInput}
            type="file"
            hidden
            accept={schemaFileExtensions.join(',')}
            onChange={event => {
              const file = event.currentTarget.files?.[0]
              event.currentTarget.value = ''
              if (file) void openSchema(file)
            }}
          />
        </div>

        {error && <p className={styles.error} role="alert">{error}</p>}

        {saves.length > 0 && (
          <section className={styles.recents} aria-labelledby="recent-projects">
            <h2 id="recent-projects" className={styles.recentHeading}>{t.savedSchemas}</h2>
            <ul className={styles.savesList}>
              {saves.map(save => {
                const isConfirming = confirmDeleteId === save.id
                return (
                  <li key={save.id} className={styles.saveRow}>
                    <button
                      type="button"
                      className={styles.openSave}
                      onClick={() => onOpen({ schema: save.schema, positions: save.positions, saveId: save.id, saveName: save.name })}
                      disabled={isOpening}
                    >
                      <span className={styles.saveIcon} aria-hidden="true">▤</span>
                      <span className={styles.saveDetails}>
                        <span className={styles.saveName}>{save.name}</span>
                        <time dateTime={save.savedAt}>{fmtDate(save.savedAt, lang)}</time>
                      </span>
                      <span className={styles.openLabel}>{t.open} <span aria-hidden="true">→</span></span>
                    </button>
                    <button
                      type="button"
                      className={`${styles.deleteSave} ${isConfirming ? styles.confirmDelete : ''}`}
                      onClick={() => handleDeleteSave(save.id)}
                      aria-label={isConfirming ? t.confirmDelete(save.name) : `${t.delete} ${save.name}`}
                      title={t.delete}
                    >
                      {isConfirming ? (lang === 'ru' ? 'Удалить?' : 'Delete?') : '×'}
                    </button>
                  </li>
                )
              })}
            </ul>
          </section>
        )}
      </main>
    </div>
  )
}
