import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import CodeMirror from '@uiw/react-codemirror'
import { EditorView } from '@codemirror/view'
import { StreamLanguage } from '@codemirror/language'
import { linter, type Diagnostic } from '@codemirror/lint'
import { oneDark } from '@codemirror/theme-one-dark'
import { schemaToDSL, dslToSchema, type DSLDiagnostic } from '../../utils/schemaDSL'
import type { Schema } from '../../types/schema'
import styles from './SchemaEditor.module.css'

const KEYWORDS = new Set(['Table', 'Relations', 'Layout'])
const MODIFIERS = new Set(['pk', 'unique', 'null', 'view'])

const schemaLang = StreamLanguage.define<Record<string, never>>({
  startState: () => ({}),
  token(stream) {
    if (stream.eatSpace()) return null
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

// underline lines that fail validation
const dslLinter = linter(view => {
  const { diagnostics } = dslToSchema(view.state.doc.toString())
  const total = view.state.doc.lines
  return diagnostics.map((d): Diagnostic => {
    const line = view.state.doc.line(Math.min(Math.max(d.line, 1), total))
    return { from: line.from, to: line.to, severity: 'error', message: d.message }
  })
}, { delay: 350 })

type Positions = Record<string, { x: number; y: number }>

interface Props {
  schema: Schema
  masterPositions: Positions
  onSchemaChange: (schema: Schema, masterPositions?: Positions) => void
  onValidityChange?: (valid: boolean) => void
  width?: number
}

export function SchemaEditor({ schema, masterPositions, onSchemaChange, onValidityChange, width = 380 }: Props) {
  const fontSize = Math.max(11, Math.min(16, Math.round(13 * width / 380)))
  const schemaRef = useRef(schema)
  schemaRef.current = schema
  const masterPositionsRef = useRef(masterPositions)
  masterPositionsRef.current = masterPositions

  const [text, setText] = useState(() => schemaToDSL(schema, masterPositions))
  const textRef = useRef(text)
  const [diagnostics, setDiagnostics] = useState<DSLDiagnostic[]>([])
  const isFocused = useRef(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const editorViewRef = useRef<EditorView | null>(null)

  // parse, validate and (if valid) apply — shared by the debounced timer and
  // the flush-on-blur/unmount paths below. Returns whether it committed.
  const commit = useCallback((value: string) => {
    const { schema: parsed, diagnostics: diags, masterPositions: parsedMaster } = dslToSchema(value, schemaRef.current)
    setDiagnostics(diags)
    onValidityChange?.(diags.length === 0)
    if (diags.length === 0) onSchemaChange(parsed, parsedMaster)
    return diags.length === 0
  }, [onSchemaChange, onValidityChange])

  useEffect(() => {
    return () => {
      // flush a pending edit instead of silently discarding it — otherwise
      // closing the panel (or navigating away) within the 400ms debounce
      // window loses whatever was just typed, and a reload shows the schema
      // from before that edit was ever applied
      if (debounceRef.current) {
        clearTimeout(debounceRef.current)
        commit(textRef.current)
      }
    }
  }, [commit])

  const [searchQuery, setSearchQuery] = useState('')
  const [searchOpen, setSearchOpen] = useState(false)
  const searchRef = useRef<HTMLInputElement>(null)
  const [selectedIdx, setSelectedIdx] = useState(0)
  const [visibleCount, setVisibleCount] = useState(12)

  useEffect(() => {
    if (!isFocused.current) {
      const next = schemaToDSL(schema, masterPositions)
      setText(next)
      textRef.current = next
      // validate the freshly-generated text instead of assuming it's clean —
      // schemaToDSL is a mechanical dump of the current schema, and that
      // schema can itself contain something the round-trip considers invalid
      // (e.g. previously the false-positive on composite-PK+FK columns).
      // Without this, the header banner said "valid" while the inline linter
      // (which re-validates independently on its own timer) underlined the
      // very same lines — sat wrong until the user's next keystroke.
      const { diagnostics: diags } = dslToSchema(next, schema)
      setDiagnostics(diags)
      onValidityChange?.(diags.length === 0)
    }
  }, [schema, masterPositions, onValidityChange])

  const handleChange = useCallback((value: string) => {
    setText(value)
    textRef.current = value
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      debounceRef.current = null
      commit(value)
    }, 400)
  }, [commit])

  const handleBlur = useCallback((e: React.FocusEvent) => {
    if (!containerRef.current?.contains(e.relatedTarget as Node)) {
      isFocused.current = false
      // flush a pending edit right away instead of leaving it to the timer —
      // and don't also reformat from (still stale) schemaRef in that case
      if (debounceRef.current) {
        clearTimeout(debounceRef.current)
        debounceRef.current = null
        commit(textRef.current)
        return
      }
      if (diagnostics.length === 0) {
        const next = schemaToDSL(schemaRef.current, masterPositionsRef.current)
        setText(next)
        textRef.current = next
      }
    }
  }, [diagnostics, commit])

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

        {/* Error mini-log — scrolls horizontally for long messages */}
        <div className={`${styles.log} ${diagnostics.length ? styles.logError : styles.logOk}`}>
          {diagnostics.length === 0
            ? <span className={styles.logOkText}>✓ valid</span>
            : diagnostics.map((d, i) => (
                <span key={i} className={styles.logItem}>⚠ line {d.line}: {d.message}</span>
              ))
          }
        </div>
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

      <div className={styles.editorWrap}>
        <CodeMirror
          value={text}
          onChange={handleChange}
          onCreateEditor={view => { editorViewRef.current = view }}
          extensions={[schemaLang, dslLinter]}
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
