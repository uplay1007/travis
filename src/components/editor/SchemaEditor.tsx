import { useState, useEffect, useRef, useCallback, useMemo, type MutableRefObject } from 'react'
import CodeMirror from '@uiw/react-codemirror'
import { EditorView, type ViewUpdate } from '@codemirror/view'
import { StreamLanguage } from '@codemirror/language'
import { linter, setDiagnostics, type Diagnostic } from '@codemirror/lint'
import { oneDark } from '@codemirror/theme-one-dark'
import { schemaToDSL, dslToSchema, type DSLDiagnostic } from '../../utils/schemaDSL'
import type { Schema } from '../../types/schema'
import styles from './SchemaEditor.module.css'

const KEYWORDS = new Set(['Table', 'Relations', 'Layout'])
const MODIFIERS = new Set(['pk', 'unique', 'null', 'view', 'comment'])

const schemaLang = StreamLanguage.define<Record<string, never>>({
  startState: () => ({}),
  token(stream) {
    if (stream.eatSpace()) return null
    if (stream.match(/"(?:[^"\\]|\\.)*"/)) return 'string'
    if (stream.match(/\/\/[^\n]*/)) return 'comment'
    if (stream.match(/--[^\n]*/)) return 'comment'
    if (stream.eat('{') || stream.eat('}')) return 'bracket'
    if (stream.eat('>')) return 'operator'
    if (stream.match(/[\w]+(?:\([^)]*\))?(?:\.\w+)*/)) {
      const w = stream.current()
      if (KEYWORDS.has(w)) return 'keyword'
      if (MODIFIERS.has(w)) return 'typeName'
      return null
    }
    stream.next()
    return null
  },
  blankLine() {},
  copyState: s => ({ ...s }),
  indent: () => null,
  languageData: {},
  tokenTable: {},
})

const DSL_EXTENSIONS = [schemaLang, linter(null)]

function showDiagnostics(view: EditorView, diagnostics: DSLDiagnostic[]) {
  const total = view.state.doc.lines
  const markers = diagnostics.map((d): Diagnostic => {
    const line = view.state.doc.line(Math.min(Math.max(d.line, 1), total))
    return { from: line.from, to: line.to, severity: 'error', message: d.message }
  })
  view.dispatch(setDiagnostics(view.state, markers))
}

type Positions = Record<string, { x: number; y: number }>
export type DSLDraftStatus = 'idle' | 'checking' | 'invalid'

interface Validation {
  text: string
  diagnostics: DSLDiagnostic[]
}

interface Props {
  schema: Schema
  masterPositions: Positions
  deletionVersion: number
  draftRef: MutableRefObject<string | null>
  onSchemaChange: (schema: Schema, masterPositions?: Positions) => void
  onStatusChange: (status: DSLDraftStatus) => void
  width?: number
}

export function SchemaEditor({ schema, masterPositions, deletionVersion, draftRef, onSchemaChange, onStatusChange, width = 380 }: Props) {
  const fontSize = Math.max(11, Math.min(16, Math.round(13 * width / 380)))
  const schemaRef = useRef(schema)
  schemaRef.current = schema
  const masterPositionsRef = useRef(masterPositions)
  masterPositionsRef.current = masterPositions

  const [text, setText] = useState(() => draftRef.current ?? schemaToDSL(schema, masterPositions))
  const textRef = useRef(text)
  const [validation, setValidation] = useState<Validation | null>(null)
  const validationRef = useRef<Validation | null>(null)
  const isFocused = useRef(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const editorViewRef = useRef<EditorView | null>(null)

  // One parser result drives the error list, the editor marks and the canvas.
  const validate = useCallback((value: string, applyDraft: boolean) => {
    const result = dslToSchema(value, schemaRef.current)
    const checked = { text: value, diagnostics: result.diagnostics }
    validationRef.current = checked
    setValidation(checked)
    if (result.diagnostics.length) {
      // Errors from an existing schema stay visible without preventing repairs
      // in the visual editor. Only an unapplied text draft locks the canvas.
      onStatusChange(draftRef.current === null ? 'idle' : 'invalid')
      return
    }
    draftRef.current = null
    if (applyDraft) onSchemaChange(result.schema, result.masterPositions)
    onStatusChange('idle')
  }, [draftRef, onSchemaChange, onStatusChange])

  const flushDraft = useCallback(() => {
    if (debounceRef.current === null) return false
    clearTimeout(debounceRef.current)
    debounceRef.current = null
    validate(textRef.current, true)
    return true
  }, [validate])

  useEffect(() => {
    return () => {
      flushDraft()
    }
  }, [flushDraft])

  const [searchQuery, setSearchQuery] = useState('')
  const [searchOpen, setSearchOpen] = useState(false)
  const searchRef = useRef<HTMLInputElement>(null)
  const [selectedIdx, setSelectedIdx] = useState(0)
  const [visibleCount, setVisibleCount] = useState(12)

  const syncFromSchema = useCallback(() => {
    if (debounceRef.current !== null) return
    // Keep the exact uncommitted text, including after hiding and reopening DSL.
    const next = draftRef.current ?? schemaToDSL(schemaRef.current, masterPositionsRef.current)
    if (next === validationRef.current?.text && next === textRef.current) return
    textRef.current = next
    setText(next)
    validate(next, false)
  }, [draftRef, validate])

  useEffect(() => {
    if (!isFocused.current) syncFromSchema()
  }, [schema, masterPositions, syncFromSchema])

  // A timer can finish deleting a table while a clean DSL document is focused.
  useEffect(() => {
    if (draftRef.current === null) syncFromSchema()
  }, [deletionVersion, draftRef, syncFromSchema])

  useEffect(() => {
    const view = editorViewRef.current
    if (view && validation?.text === view.state.doc.toString()) {
      showDiagnostics(view, validation.diagnostics)
    }
  }, [validation])

  const handleEditorUpdate = useCallback((update: ViewUpdate) => {
    const checked = validationRef.current
    if (!update.docChanged || checked?.text !== update.state.doc.toString()) return
    // CodeMirror may apply a document update from a prop after the effect above.
    queueMicrotask(() => {
      const view = editorViewRef.current
      if (view === update.view && view.dom.isConnected && view.state.doc === update.state.doc &&
          checked === validationRef.current) {
        showDiagnostics(view, checked.diagnostics)
      }
    })
  }, [])

  const diagnostics = validation?.diagnostics ?? []
  const checking = text !== validation?.text

  const handleChange = useCallback((value: string) => {
    setText(value)
    textRef.current = value
    draftRef.current = value
    onStatusChange('checking')
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      debounceRef.current = null
      validate(value, true)
    }, 400)
  }, [draftRef, onStatusChange, validate])

  const handleBlur = useCallback((e: React.FocusEvent) => {
    if (!containerRef.current?.contains(e.relatedTarget as Node)) {
      isFocused.current = false
      if (!flushDraft()) syncFromSchema()
    }
  }, [flushDraft, syncFromSchema])

  const tableNames = useMemo(
    () => schema.tables.map(t => t.name),
    [schema.tables]
  )

  const searchResults = useMemo(() => {
    if (!searchQuery.trim()) return tableNames
    const q = searchQuery.toLowerCase()
    return tableNames.filter(n => n.toLowerCase().includes(q))
  }, [searchQuery, tableNames])

  const scrollToTable = useCallback((name: string) => {
    const view = editorViewRef.current
    if (!view) return
    const doc = view.state.doc.toString()
    const re = new RegExp(`^Table\\s+${name}\\s*\\{`, 'm')
    const match = re.exec(doc)
    if (!match) return
    view.dispatch({
      selection: { anchor: match.index },
      effects: EditorView.scrollIntoView(match.index, { y: 'start', yMargin: 24 }),
    })
    view.focus()
    setSearchOpen(false)
    setSearchQuery('')
  }, [])

  const scrollToError = (lineNumber: number) => {
    const view = editorViewRef.current
    if (!view) return
    const line = view.state.doc.line(Math.min(lineNumber, view.state.doc.lines))
    view.dispatch({
      selection: { anchor: line.from },
      effects: EditorView.scrollIntoView(line.from, { y: 'center' }),
    })
    view.focus()
  }

  const handleSearchKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { setSearchOpen(false); setSearchQuery('') }
    if (e.key === 'ArrowDown') { e.preventDefault(); setSelectedIdx(i => Math.min(i + 1, searchResults.length - 1)) }
    if (e.key === 'ArrowUp') { e.preventDefault(); setSelectedIdx(i => Math.max(i - 1, 0)) }
    if (e.key === 'Enter' && searchResults[selectedIdx]) scrollToTable(searchResults[selectedIdx])
  }, [searchResults, selectedIdx, scrollToTable])

  useEffect(() => { setSelectedIdx(0); setVisibleCount(12) }, [searchQuery])
  useEffect(() => { if (searchOpen) searchRef.current?.focus() }, [searchOpen])

  return (
    <div
      ref={containerRef}
      className={styles.root}
      onFocus={() => { isFocused.current = true }}
      onBlur={handleBlur}
    >
      <div className={styles.header}>
        <span className={styles.headerLabel}>Schema</span>

        <button
          onClick={() => setSearchOpen(o => !o)}
          title="Search table (Ctrl+F)"
          className={`${styles.searchBtn} ${searchOpen ? styles.searchBtnActive : ''}`}
        >
          <span>⌕</span>
          <span>Find table</span>
        </button>

        <span role="status" className={`${styles.status} ${checking ? '' : diagnostics.length ? styles.statusError : styles.statusOk}`}>
          {checking ? 'Checking…' : diagnostics.length === 0
            ? '✓ valid'
            : `${diagnostics.length} ${diagnostics.length === 1 ? 'error' : 'errors'}`}
        </span>
      </div>

      {searchOpen && (
        <div className={styles.searchBar}>
          <input
            ref={searchRef}
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            onKeyDown={handleSearchKeyDown}
            placeholder={`Search in ${tableNames.length} tables...`}
            className={styles.searchInput}
          />

          {searchResults.length > 0 && (
            <div className={styles.dropdown}>
              {searchResults.slice(0, visibleCount).map((name, i) => (
                <button
                  key={name}
                  onMouseDown={() => scrollToTable(name)}
                  onMouseEnter={() => setSelectedIdx(i)}
                  className={`${styles.dropdownItem} ${i === selectedIdx ? styles.dropdownItemSelected : ''}`}
                >
                  <span className={styles.dropdownItemTableLabel}>Table</span>
                  {name}
                </button>
              ))}
              {searchResults.length > visibleCount && (
                <div className={styles.dropdownFooter}>
                  <button
                    onMouseDown={e => { e.preventDefault(); setVisibleCount(c => c + 5) }}
                    className={styles.showMoreBtn}
                  >
                    Show +5
                  </button>
                  <span className={styles.showMoreLabel}>
                    +{searchResults.length - visibleCount} more...
                  </span>
                </div>
              )}
            </div>
          )}

          {searchQuery && searchResults.length === 0 && (
            <div className={styles.noResults}>No table found</div>
          )}
        </div>
      )}

      {diagnostics.length > 0 && (
        <ul className={styles.diagnostics} aria-label="Schema errors">
          {diagnostics.map((diagnostic, index) => (
            <li key={index}>
              <button
                type="button"
                className={styles.diagnosticButton}
                onClick={() => scrollToError(diagnostic.line)}
              >
                <span className={styles.diagnosticLine}>Line {diagnostic.line}</span>
                <span className={styles.diagnosticMessage}>{diagnostic.message}</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className={styles.editorWrap}>
        <CodeMirror
          value={text}
          onChange={handleChange}
          onUpdate={handleEditorUpdate}
          onCreateEditor={view => { editorViewRef.current = view }}
          extensions={DSL_EXTENSIONS}
          theme={oneDark}
          style={{ fontSize }}
          basicSetup={{
            lineNumbers: true,
            foldGutter: false,
            bracketMatching: true,
            closeBrackets: false,
            autocompletion: false,
            highlightActiveLine: true,
          }}
        />
      </div>
    </div>
  )
}
