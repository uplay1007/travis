import { useState, useCallback } from 'react'
import { parseSchema, detectParser, type ParserType } from '../../utils/parsers'
import { openFilePicker, getHandleFromDrop, supportsFileSystemAccess } from '../../utils/fileAccess'
import type { Schema } from '../../types/schema'
import { Logo } from '../ui/Logo'
import { ThemeSwitch } from '../ui/ThemeSwitch'
import styles from './UploadZone.module.css'

export interface OpenResult {
  schema: Schema
  fileHandle?: FileSystemFileHandle
  positions?: Record<string, { x: number; y: number }>
}

interface Props {
  theme: 'dark' | 'light'
  onThemeToggle: () => void
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

export function UploadZone({ theme, onThemeToggle, onOpen }: Props) {
  const [parserType, setParserType] = useState<ParserType>('json')
  const [text, setText] = useState('')
  const [error, setError] = useState('')
  const [dragging, setDragging] = useState(false)
  const hasFileAccess = supportsFileSystemAccess()

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
      </div>
    </div>
  )
}

const DEMO_SCHEMA = JSON.stringify({ tables: [
  { name: "users", columns: [{ name: "id", type: "integer", primaryKey: true, nullable: false }, { name: "role_id", type: "integer", nullable: false, foreignKey: { table: "roles", column: "id" } }, { name: "email", type: "varchar", nullable: false, unique: true }] },
  { name: "roles", columns: [{ name: "id", type: "integer", primaryKey: true, nullable: false }, { name: "name", type: "varchar", nullable: false, unique: true }] },
  { name: "posts", columns: [{ name: "id", type: "integer", primaryKey: true, nullable: false }, { name: "user_id", type: "integer", nullable: false, foreignKey: { table: "users", column: "id" } }, { name: "title", type: "varchar", nullable: false }] },
]}, null, 2)
