import { useState, useCallback, useMemo, useEffect, useRef } from 'react'
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  SelectionMode,
  useNodesState,
  useEdgesState,
  useNodesInitialized,
  type Node,
  type Edge,
  type OnSelectionChangeParams,
  type ReactFlowInstance,
  type NodeChange,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'

import type { Schema, Table, Column, Layout } from './types/schema'
import { computeLayout } from './utils/layout'
import { tableColor, tagColor } from './utils/colors'
import {
  saveCurrentSession, loadCurrentSession, clearCurrentSession,
} from './utils/storage'
import { TableNode, type TableNodeData, MultiSelectCtx } from './components/canvas/TableNode'
import { HighlightCtx, type HighlightCtxValue } from './contexts/highlight'
import { EdgeHoverCtx, type EdgeEndpoint } from './contexts/edgeHover'
import { ViewModeCtx, type ViewMode, type ViewModeCtxValue } from './contexts/viewMode'
import { OrthoEdge, type OrthoEdgeData } from './components/canvas/OrthoEdge'
import { computeELKLayout } from './services/layoutService'
import { resolveOverlaps, type Rect } from './utils/separateNodes'
import { TableEditor } from './components/editor/TableEditor'
import { Sidebar } from './components/shell/Sidebar'
import { SchemaEditor } from './components/editor/SchemaEditor'
import { UploadZone, type OpenResult } from './components/shell/UploadZone'
import { writeToHandle } from './utils/fileAccess'
import { exportSQL } from './utils/parsers/sql'
import { schemaToStructured } from './utils/structuredJSON'
import { T, type Lang } from './i18n'
import { DialogProvider, useDialog } from './contexts/DialogContext'
import { useAuth } from './contexts/AuthContext'
import { AuthScreen } from './components/auth/AuthScreen'
import { Logo } from './components/ui/Logo'
import { upsertSave } from './services/schemasAPI'
import appStyles from './App.module.css'

const NODE_TYPES = { table: TableNode }
const EDGE_TYPES = { fk: OrthoEdge }

function NodesInitializedFitView({ rfRef }: { rfRef: React.RefObject<ReactFlowInstance<any, any> | null> }) {
  const initialized = useNodesInitialized()
  const didFit = useRef(false)
  useEffect(() => {
    // fit once per mount (fresh schema open); never on later node re-inits (edits)
    if (initialized && !didFit.current) {
      didFit.current = true
      rfRef.current?.fitView({ padding: 0.2, duration: 300 })
    }
  }, [initialized, rfRef])
  return null
}

function getRelType(table: Table, col: Column): '1:1' | '1:N' | 'N:M' {
  if (col.unique) return '1:1'
  const fkCols = table.columns.filter(c => c.foreignKey)
  if (fkCols.length >= 2 && fkCols.length >= table.columns.length - 1) return 'N:M'
  return '1:N'
}

// Tables whose entire FK-neighborhood (both directions) is just `focus` —
// i.e. connected only to the focused table and to nothing else.
function exclusiveNeighbors(tables: Table[], focus: string): string[] {
  const result: string[] = []
  for (const t of tables) {
    if (t.name === focus) continue
    const partners = new Set<string>()
    for (const col of t.columns) {
      if (col.foreignKey && col.foreignKey.table !== t.name) partners.add(col.foreignKey.table)
    }
    for (const other of tables) {
      if (other.name === t.name) continue
      for (const col of other.columns) {
        if (col.foreignKey?.table === t.name) partners.add(other.name)
      }
    }
    if (partners.has(focus) && [...partners].every(p => p === focus)) result.push(t.name)
  }
  return result
}

function schemaToFlow(
  schema: Schema,
  onEdit: (t: Table) => void,
  savedPositions?: Record<string, { x: number; y: number }>,
  existingNodes?: Node[]
): { nodes: Node[]; edges: Edge[] } {
  const existingMap = Object.fromEntries((existingNodes ?? []).map(n => [n.id, n.position]))

  const tablesNeedingLayout = schema.tables.filter(t =>
    !existingMap[t.name] && !savedPositions?.[t.name]
  )
  const layoutMap = tablesNeedingLayout.length > 0
    ? Object.fromEntries(
        computeLayout({ tables: tablesNeedingLayout })
          .map(p => [p.id, { x: p.x, y: p.y }])
      )
    : {}

  const nodes: Node[] = schema.tables.map(table => ({
    id: table.name,
    type: 'table',
    position:
      existingMap[table.name] ??
      savedPositions?.[table.name] ??
      layoutMap[table.name] ??
      { x: 0, y: 0 },
    data: { table, onEdit } satisfies TableNodeData,
  }))

  const tableMap = new Map(schema.tables.map(t => [t.name, t]))
  const edges: Edge[] = []
  const seen = new Set<string>()
  for (const table of schema.tables) {
    for (const col of table.columns) {
      if (!col.foreignKey) continue
      const target = col.foreignKey.table
      if (target === table.name) continue
      const targetTable = tableMap.get(target)
      if (!targetTable) continue
      const key = `${table.name}-${target}-${col.name}`
      if (seen.has(key)) continue
      seen.add(key)
      edges.push({
        id: key, source: table.name, target,
        type: 'fk',
        data: {
          label: `${col.name} → ${col.foreignKey.column}`,
          color: '#4b5563',
          relType: getRelType(table, col),
          sourceColor: tagColor(table.tags),
          targetColor: tagColor(targetTable.tags),
          sourceColumn: col.name,
          targetColumn: col.foreignKey.column,
        } satisfies OrthoEdgeData,
      })
    }
  }
  return { nodes, edges }
}

type EditorState = null | 'new' | string

function exportJSON(schema: Schema) {
  const blob = new Blob([JSON.stringify(schemaToStructured(schema), null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url; a.download = 'schema.json'; a.click()
  URL.revokeObjectURL(url)
}

function downloadSQL(schema: Schema) {
  const sql = exportSQL(schema)
  const blob = new Blob([sql], { type: 'text/plain' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url; a.download = 'schema.sql'; a.click()
  URL.revokeObjectURL(url)
}

export default function App() {
  const [lang, setLang] = useState<Lang>('en')
  const { user, loading } = useAuth()

  if (loading) return (
    <div className={appStyles.loadingScreen}>
      <span className={appStyles.loadingText}>Loading...</span>
    </div>
  )

  if (!user) return <AuthScreen />

  return (
    <DialogProvider lang={lang}>
      <AppContent lang={lang} setLang={setLang} />
    </DialogProvider>
  )
}

function AppContent({ lang, setLang }: { lang: Lang; setLang: React.Dispatch<React.SetStateAction<Lang>> }) {
  const session = useMemo(() => loadCurrentSession(), [])
  const dialog = useDialog()

  const [schema, setSchema] = useState<Schema | null>(session?.schema ?? null)
  const [currentSaveId, setCurrentSaveId] = useState<string | undefined>(session?.saveId)
  const currentSaveIdRef = useRef<string | undefined>(session?.saveId)
  const currentSaveName = useRef<string | null>(session?.saveName ?? null)
  const [fileHandle, setFileHandle] = useState<FileSystemFileHandle | null>(null)

  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([])
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([])
  const nodesRef = useRef<Node[]>([])
  useEffect(() => { nodesRef.current = nodes }, [nodes])
  useEffect(() => { currentSaveIdRef.current = currentSaveId }, [currentSaveId])

  const masterPositionsRef = useRef<Record<string, { x: number; y: number }>>(session?.positions ?? {})

  const [editorState, setEditorState] = useState<EditorState>(null)
  const [saveFlash, setSaveFlash] = useState(false)

  const rfInstanceRef = useRef<ReactFlowInstance<any, any> | null>(null)
  const groupsBtnRef = useRef<HTMLDivElement>(null)

  const [canvasMode, setCanvasMode] = useState<'pan' | 'select'>('pan')
  const [viewMode, setViewMode] = useState<ViewMode>('full')
  const [tagFilter, setTagFilter] = useState<string | null>(null)
  const [groupsOpen, setGroupsOpen] = useState(false)
  const [activeLayoutId, setActiveLayoutId] = useState<string | null>(null)
  const [layoutsOpen, setLayoutsOpen] = useState(false)
  const [layoutSettingsId, setLayoutSettingsId] = useState<string | null>(null)
  const layoutsBtnRef = useRef<HTMLDivElement>(null)
  // live per-layout positions (mirrors masterPositionsRef); folded into schema.layouts on save
  const layoutPosRef = useRef<Record<string, Record<string, { x: number; y: number }>>>({})
  const [bulkExpand, setBulkExpand] = useState(true)
  const [bulkKey, setBulkKey] = useState(0)
  // view mode for the non-layout view (All tables + tag groups)
  const [baseViewMode, setBaseViewMode] = useState<ViewMode>('full')

  // apply a detail level to the canvas (selector + bulk expand/collapse broadcast)
  const applyViewMode = useCallback((mode: ViewMode) => {
    setViewMode(mode)
    setBulkExpand(mode !== 'collapsed')
    setBulkKey(k => k + 1)
  }, [])

  // change the mode from the selector — persist it to the active view
  const handleViewMode = useCallback((mode: ViewMode) => {
    applyViewMode(mode)
    if (activeLayoutId) {
      setSchema(s => s ? { ...s, layouts: (s.layouts ?? []).map(l => l.id === activeLayoutId ? { ...l, viewMode: mode } : l) } : s)
    } else {
      setBaseViewMode(mode)
    }
  }, [applyViewMode, activeLayoutId])

  const [splitView, setSplitView] = useState(false)
  const [schemaValid, setSchemaValid] = useState(true)
  const [editorWidth, setEditorWidth] = useState(380)
  const editorWidthRef = useRef(380)
  useEffect(() => { editorWidthRef.current = editorWidth }, [editorWidth])
  const isDraggingRef = useRef(false)
  const dragStartXRef = useRef(0)
  const dragStartWidthRef = useRef(0)

  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    isDraggingRef.current = true
    dragStartXRef.current = e.clientX
    dragStartWidthRef.current = editorWidthRef.current
    const onMove = (ev: MouseEvent) => {
      if (!isDraggingRef.current) return
      const delta = ev.clientX - dragStartXRef.current
      setEditorWidth(Math.max(200, Math.min(800, dragStartWidthRef.current + delta)))
    }
    const onUp = () => {
      isDraggingRef.current = false
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [])

  const [multiSelectActive, setMultiSelectActive] = useState(false)
  const [highlightTable, setHighlightTable] = useState<string | null>(null)
  const [selectedTables, setSelectedTables] = useState<Set<string>>(new Set())
  const [layouting, setLayouting] = useState(false)
  const [pendingELK, setPendingELK] = useState(false)

  const activeLayout = useMemo(
    () => schema?.layouts?.find(l => l.id === activeLayoutId) ?? null,
    [schema, activeLayoutId]
  )

  const displayNodes = useMemo(() => {
    if (activeLayout) {
      const visible = new Set(activeLayout.tables)
      const pos = layoutPosRef.current[activeLayout.id] ?? {}
      return nodes.map(n => ({
        ...n,
        hidden: !visible.has(n.id),
        position: pos[n.id] ?? n.position,
      }))
    }
    if (!tagFilter || !schema) {
      return nodes.map(n => ({
        ...n,
        hidden: false,
        position: masterPositionsRef.current[n.id] ?? n.position
      }))
    }
    const visible = new Set(schema.tables.filter(t => t.tags?.includes(tagFilter)).map(t => t.name))
    return nodes.map(n => ({ ...n, hidden: !visible.has(n.id) }))
  }, [nodes, tagFilter, schema, activeLayout])

  const displayEdges = useMemo(() => {
    if (activeLayout) {
      const visible = new Set(activeLayout.tables)
      return edges.filter(e => visible.has(e.source) && visible.has(e.target))
    }
    if (!tagFilter || !schema) return edges
    const visibleNames = new Set(schema.tables.filter(t => t.tags?.includes(tagFilter)).map(t => t.name))
    return edges.filter(e => visibleNames.has(e.source) && visibleNames.has(e.target))
  }, [edges, tagFilter, schema, activeLayout])

  const handleSelectionChange = useCallback(({ nodes: sel }: OnSelectionChangeParams) => {
    setMultiSelectActive(sel.length > 1)
  }, [])

  const allTags = useMemo(() => {
    if (!schema) return []
    const counts: Record<string, number> = {}
    for (const t of schema.tables) {
      for (const tag of (t.tags ?? [])) counts[tag] = (counts[tag] ?? 0) + 1
    }
    return Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([tag, count]) => ({ tag, count }))
  }, [schema])

  useEffect(() => {
    if (!groupsOpen) return
    const handler = (e: MouseEvent) => {
      if (!groupsBtnRef.current?.contains(e.target as globalThis.Node)) setGroupsOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [groupsOpen])

  useEffect(() => {
    if (!layoutsOpen) return
    const handler = (e: MouseEvent) => {
      if (!layoutsBtnRef.current?.contains(e.target as globalThis.Node)) setLayoutsOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [layoutsOpen])

  const selectTagGroup = useCallback((tag: string | null) => {
    setActiveLayoutId(null)
    setTagFilter(tag)
    setGroupsOpen(false)
    applyViewMode(baseViewMode)
  }, [applyViewMode, baseViewMode])

  const prevTagFilterRef = useRef<string | null>(tagFilter)
  useEffect(() => {
    if (!schema) return
    // only re-frame when the tag group actually changes — not on content/viewMode edits
    const tagChanged = prevTagFilterRef.current !== tagFilter
    prevTagFilterRef.current = tagFilter
    setHighlightTable(null)

    if (!tagFilter) {
      if (Object.keys(masterPositionsRef.current).length > 0) {
        setNodes(prev => prev.map(n => ({
          ...n,
          position: masterPositionsRef.current[n.id] ?? n.position,
        })))
      }
      if (tagChanged) setTimeout(() => rfInstanceRef.current?.fitView({ padding: 0.2, duration: 400 }), 50)
      return
    }

    const visibleNames = new Set(schema.tables.filter(t => t.tags?.includes(tagFilter)).map(t => t.name))
    if (visibleNames.size === 0) return

    const heights: Record<string, number> = {}
    if (viewMode !== 'collapsed') {
      nodesRef.current.forEach(n => {
        const h = (n.measured as { height?: number } | undefined)?.height
        if (h) heights[n.id] = h
      })
    }

    computeELKLayout(schema, heights, visibleNames).then(({ positions }) => {
      setNodes(prev => prev.map(n =>
        positions[n.id] ? { ...n, position: positions[n.id] } : n
      ))
      if (tagChanged) setTimeout(() => rfInstanceRef.current?.fitView({ padding: 0.2, duration: 400 }), 50)
    })
  }, [tagFilter, schema, setNodes, viewMode])

  const clearHighlight = useCallback(() => {
    setHighlightTable(null)
    setSelectedTables(new Set())
  }, [])

  // Click a table header. Shift builds a manual selection group (seeded from
  // the current focus + its FK neighbors are dimmed); plain click focuses.
  const handleTableClick = useCallback((name: string, mods: { shift: boolean; alt: boolean }) => {
    // Alt/Option: select the table + tables connected ONLY to it (exclusive satellites)
    if (mods.alt) {
      if (!schema) return
      setHighlightTable(name)
      setSelectedTables(new Set([name, ...exclusiveNeighbors(schema.tables, name)]))
      return
    }
    if (mods.shift) {
      setSelectedTables(prev => {
        if (prev.size === 0) {
          return highlightTable ? new Set([highlightTable, name]) : new Set([name])
        }
        const next = new Set(prev)
        if (next.has(name)) next.delete(name)
        else next.add(name)
        return next
      })
    } else {
      setSelectedTables(new Set())
      setHighlightTable(prev => (prev === name ? null : name))
    }
  }, [highlightTable, schema])

  const highlightCtxValue = useMemo((): HighlightCtxValue => {
    // manual selection mode takes precedence over neighbor highlight
    if (selectedTables.size > 0) {
      const lit = new Set(selectedTables)
      if (highlightTable) lit.add(highlightTable)
      return { active: true, highlighted: lit, focusTable: highlightTable, groupMode: true, onHighlight: handleTableClick }
    }
    if (!highlightTable || !schema) {
      return { active: false, highlighted: new Set(), focusTable: null, groupMode: false, onHighlight: handleTableClick }
    }
    const set = new Set<string>([highlightTable])
    for (const t of schema.tables) {
      for (const col of t.columns) {
        if (!col.foreignKey) continue
        if (t.name === highlightTable) set.add(col.foreignKey.table)
        if (col.foreignKey.table === highlightTable) set.add(t.name)
      }
    }
    return { active: true, highlighted: set, focusTable: highlightTable, groupMode: false, onHighlight: handleTableClick }
  }, [highlightTable, selectedTables, schema, handleTableClick, clearHighlight])

  const [edgeHover, setEdgeHover] = useState<{ source: EdgeEndpoint; target: EdgeEndpoint } | null>(null)
  const edgeHoverCtxValue = useMemo(() => ({
    source: edgeHover?.source ?? null,
    target: edgeHover?.target ?? null,
    setHover: setEdgeHover,
  }), [edgeHover])

  const handleLayout = useCallback(async () => {
    if (!schema || layouting) return
    setLayouting(true)
    try {
      const heights: Record<string, number> = {}
      if (viewMode !== 'collapsed') {
        nodesRef.current.forEach(n => {
          const h = (n.measured as { height?: number } | undefined)?.height
          if (h) heights[n.id] = h
        })
      }
      const filter = activeLayout ? new Set(activeLayout.tables) : undefined
      const { positions } = await computeELKLayout(schema, heights, filter)
      if (activeLayout) {
        layoutPosRef.current[activeLayout.id] = { ...(layoutPosRef.current[activeLayout.id] ?? {}), ...positions }
      } else if (!tagFilter) {
        masterPositionsRef.current = { ...positions }
      }
      setNodes(prev => prev.map(n => ({ ...n, position: positions[n.id] ?? n.position })))
      // re-frame the camera on the freshly arranged tables
      setTimeout(() => rfInstanceRef.current?.fitView({ padding: 0.2, duration: 400 }), 60)
    } catch (err) {
      console.error('ELK layout failed:', err)
    } finally {
      setLayouting(false)
    }
  }, [schema, layouting, setNodes, tagFilter, viewMode, activeLayout])

  useEffect(() => {
    if (!pendingELK || layouting || nodes.length === 0) return
    const visibleNodes = tagFilter && schema
      ? nodes.filter(n => schema.tables.find(t => t.name === n.id)?.tags?.includes(tagFilter))
      : nodes
    if (visibleNodes.length === 0) return
    const measuredCount = visibleNodes.filter(n => (n.measured as { height?: number } | undefined)?.height).length
    if (measuredCount < visibleNodes.length) return
    setPendingELK(false)
    handleLayout()
  }, [pendingELK, nodes, layouting, handleLayout, tagFilter, schema])

  // persist a dragged position to the active view: layout ref, else master
  // (tag-filter view is ephemeral — no persistence)
  const persistPos = useCallback((id: string, pos: { x: number; y: number }) => {
    if (activeLayoutId) {
      (layoutPosRef.current[activeLayoutId] ??= {})[id] = pos
    } else if (!tagFilter) {
      masterPositionsRef.current[id] = pos
    }
  }, [activeLayoutId, tagFilter])

  const handleNodesChange = useCallback((changes: NodeChange[]) => {
    onNodesChange(changes)
    changes.forEach(c => {
      if (c.type === 'position' && c.position) persistPos(c.id, c.position)
    })
  }, [onNodesChange, persistPos])

  const groupDragOrigins = useRef<Record<string, { x: number; y: number }>>({})

  const handleNodeDragStart = useCallback((_e: MouseEvent | TouchEvent, node: Node) => {
    if (!highlightCtxValue.highlighted.has(node.id)) return
    groupDragOrigins.current = Object.fromEntries(
      nodes
        .filter(n => highlightCtxValue.highlighted.has(n.id))
        .map(n => [n.id, { x: n.position.x, y: n.position.y }])
    )
  }, [highlightCtxValue.highlighted, nodes])

  const handleNodeDrag = useCallback((_e: MouseEvent | TouchEvent, node: Node) => {
    const isHighlighted = highlightCtxValue.highlighted.has(node.id)

    persistPos(node.id, { x: node.position.x, y: node.position.y })

    if (!isHighlighted) return
    const origin = groupDragOrigins.current[node.id]
    if (!origin) return
    const dx = node.position.x - origin.x
    const dy = node.position.y - origin.y
    setNodes(prev => prev.map(n => {
      if (n.id === node.id) return n
      if (!highlightCtxValue.highlighted.has(n.id)) return n
      const o = groupDragOrigins.current[n.id]
      if (!o) return n
      const newPos = { x: o.x + dx, y: o.y + dy }
      persistPos(n.id, newPos)
      return { ...n, position: newPos }
    }))
  }, [highlightCtxValue.highlighted, setNodes, persistPos])

  const handleNodeDragStop = useCallback((_e: MouseEvent | TouchEvent, node: Node) => {
    const current = nodesRef.current
    if (current.length === 0) return

    // in a layout, only its visible tables take part in overlap resolution
    const visibleSet = activeLayout ? new Set(activeLayout.tables) : null

    const rects = new Map<string, Rect>()
    for (const n of current) {
      if (visibleSet && !visibleSet.has(n.id)) continue
      const m = n.measured as { width?: number; height?: number } | undefined
      rects.set(n.id, { x: n.position.x, y: n.position.y, w: m?.width ?? 280, h: m?.height ?? 120 })
    }

    // pin only the grabbed node; everything else (incl. highlighted FK
    // neighbors that moved with it) is pushable, so overlaps within the
    // highlighted group get resolved too
    const resolved = resolveOverlaps(rects, new Set([node.id]))

    resolved.forEach((p, id) => persistPos(id, p))
    setNodes(prev => prev.map(n => {
      const p = resolved.get(n.id)
      if (!p || (p.x === n.position.x && p.y === n.position.y)) return n
      return { ...n, position: p }
    }))
  }, [setNodes, persistPos, activeLayout])

  // ── Layouts ────────────────────────────────────────────────────────────
  const selectLayout = useCallback((id: string | null) => {
    setActiveLayoutId(id)
    setTagFilter(null)
    setHighlightTable(null); setSelectedTables(new Set())
    setLayoutsOpen(false)
    // restore this view's saved detail level
    const mode = id ? (schema?.layouts?.find(l => l.id === id)?.viewMode ?? 'full') : baseViewMode
    applyViewMode(mode)
    setTimeout(() => rfInstanceRef.current?.fitView({ padding: 0.2, duration: 400 }), 60)
  }, [schema, baseViewMode, applyViewMode])

  const createLayoutFromSelection = useCallback(() => {
    if (!schema) return
    const tables = [...highlightCtxValue.highlighted]
    if (tables.length === 0) return
    const positions: Record<string, { x: number; y: number }> = {}
    for (const n of nodesRef.current) {
      if (tables.includes(n.id)) positions[n.id] = { x: n.position.x, y: n.position.y }
    }
    const id = crypto.randomUUID()
    const name = `Layout ${(schema.layouts?.length ?? 0) + 1}`
    layoutPosRef.current[id] = positions
    const layouts = [...(schema.layouts ?? []), { id, name, tables, positions, viewMode }]
    setSchema({ ...schema, layouts })
    setSelectedTables(new Set()); setHighlightTable(null)
    setTagFilter(null); setLayoutsOpen(false)
    setActiveLayoutId(id)
    setTimeout(() => rfInstanceRef.current?.fitView({ padding: 0.2, duration: 400 }), 60)
  }, [schema, highlightCtxValue.highlighted, viewMode])

  const renameLayout = useCallback((id: string, name: string) => {
    if (!schema || !name.trim()) return
    setSchema({ ...schema, layouts: (schema.layouts ?? []).map(l => l.id === id ? { ...l, name: name.trim() } : l) })
  }, [schema])

  const deleteLayout = useCallback((id: string) => {
    if (!schema) return
    delete layoutPosRef.current[id]
    setSchema({ ...schema, layouts: (schema.layouts ?? []).filter(l => l.id !== id) })
    setLayoutSettingsId(null)
    if (activeLayoutId === id) selectLayout(null)
  }, [schema, activeLayoutId, selectLayout])

  const t = T[lang]
  const handleEdit = useCallback((table: Table) => setEditorState(table.name), [])

  // refresh layouts' stored positions from the live ref before persisting
  const serializeSchema = useCallback((s: Schema): Schema => {
    if (!s.layouts?.length) return s
    return { ...s, layouts: s.layouts.map(l => ({ ...l, positions: layoutPosRef.current[l.id] ?? l.positions })) }
  }, [])

  const applySchema = useCallback((
    s: Schema,
    currentNodes?: Node[],
    initialSavedPos?: Record<string, { x: number; y: number }>
  ) => {
    const schemaToUse = { ...s, tables: s.tables.map(t => t.tags !== undefined ? t : { ...t, tags: [] }) }
    if (initialSavedPos) masterPositionsRef.current = { ...initialSavedPos }
    // keep live layout positions if this layout is already loaded (in-session edits);
    // fall back to stored positions for freshly opened schemas
    layoutPosRef.current = Object.fromEntries(
      (schemaToUse.layouts ?? []).map(l => [l.id, layoutPosRef.current[l.id] ?? { ...l.positions }])
    )
    setSchema(schemaToUse)
    saveCurrentSession({ schema: schemaToUse, positions: masterPositionsRef.current, saveId: currentSaveIdRef.current, saveName: currentSaveName.current ?? undefined })
    const { nodes: n, edges: e } = schemaToFlow(schemaToUse, handleEdit, masterPositionsRef.current, currentNodes)
    setNodes(n)
    setEdges(e)
  }, [handleEdit, setNodes, setEdges])

  const handleSchemaFromEditor = useCallback((newSchema: Schema) => {
    applySchema(newSchema, undefined, masterPositionsRef.current)
  }, [applySchema])

  useEffect(() => {
    if (session) {
      applySchema(session.schema, undefined, session.positions)
      const hasPositions = session.positions && Object.keys(session.positions).length > 0
      if (!hasPositions) setTimeout(() => setPendingELK(true), 250)
    }
  }, [session, applySchema])

  useEffect(() => {
    if (nodes.length === 0 || !schema) return
    const handle = setTimeout(() => {
      saveCurrentSession({ schema: serializeSchema(schema), positions: masterPositionsRef.current, saveId: currentSaveIdRef.current, saveName: currentSaveName.current ?? undefined })
    }, 1000)
    return () => clearTimeout(handle)
  }, [nodes, schema, serializeSchema])

  const handleSave = useCallback(async () => {
    if (!schema) return
    const posMap = { ...masterPositionsRef.current }
    const schemaOut = serializeSchema(schema)

    if (fileHandle) {
      const isSql  = fileHandle.name.endsWith('.sql')
      const isJson = fileHandle.name.endsWith('.json')
      if (!isSql && !isJson) {
        exportJSON(schemaOut)
        dialog.alert(
          lang === 'ru' ? 'Формат файла' : 'File format',
          lang === 'ru'
            ? `Файл "${fileHandle.name}" нельзя перезаписать (формат не поддерживает экспорт). Схема скачана как JSON.`
            : `"${fileHandle.name}" cannot be overwritten (export not supported for this format). Schema downloaded as JSON.`
        )
        return
      }
      try {
        const content = isSql ? exportSQL(schemaOut) : JSON.stringify(schemaToStructured(schemaOut), null, 2)
        await writeToHandle(fileHandle, content)
      } catch (e) {
        console.warn('File write failed, falling back to download', e)
        exportJSON(schemaOut)
        dialog.alert(
          lang === 'ru' ? 'Ошибка записи' : 'Write failed',
          lang === 'ru' ? 'Не удалось сохранить в файл. Схема скачана как копия.' : 'Could not write to file. Schema downloaded as a copy instead.'
        )
        return
      }
    }

    try {
      if (currentSaveId && currentSaveName.current) {
        await upsertSave(currentSaveName.current, schemaOut, posMap, currentSaveId)
      } else {
        const fileDefault = fileHandle?.name.replace(/\.[^.]+$/, '')
        const defaultName = fileDefault ?? schema.tables.map(tb => tb.name).slice(0, 2).join(', ') + (schema.tables.length > 2 ? '…' : '')
        const name = await dialog.prompt(lang === 'ru' ? 'Название сохранения' : 'Save name', t.saveNamePrompt, defaultName)
        if (!name) return
        const saved = await upsertSave(name, schemaOut, posMap)
        setCurrentSaveId(saved.id)
        currentSaveIdRef.current = saved.id
        currentSaveName.current = name
      }
    } catch (e) {
      dialog.alert(
        lang === 'ru' ? 'Ошибка сохранения' : 'Save failed',
        (e as Error).message
      )
      return
    }

    setSaveFlash(true)
    setTimeout(() => setSaveFlash(false), 1500)
    dialog.alert(lang === 'ru' ? 'Сохранение' : 'Saved', lang === 'ru' ? 'Изменения успешно сохранены!' : 'All changes have been successfully saved.')
  }, [schema, currentSaveId, fileHandle, t, dialog, lang, serializeSchema])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); handleSave() }
      if (e.key === 'Escape') clearHighlight()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [handleSave, clearHighlight])

  const handleExit = useCallback(() => {
    clearCurrentSession(); setSchema(null); setCurrentSaveId(undefined)
    currentSaveIdRef.current = undefined
    currentSaveName.current = null
    setFileHandle(null); setTagFilter(null); setActiveLayoutId(null); setEditorState(null)
  }, [])

  const handleEditorSave = useCallback((updated: Table, originalName: string | null) => {
    if (!schema) return
    let newTables: Table[]
    if (originalName === null) {
      newTables = [...schema.tables, updated]
    } else {
      const oldName = originalName
      const newName = updated.name
      newTables = schema.tables.map(tb => {
        if (tb.name === oldName) return updated
        if (oldName !== newName) {
          return {
            ...tb,
            columns: tb.columns.map(c =>
              c.foreignKey?.table === oldName ? { ...c, foreignKey: { ...c.foreignKey, table: newName } } : c
            ),
          }
        }
        return tb
      })
    }
    if (originalName && originalName !== updated.name) {
      const pos = masterPositionsRef.current[originalName]
      if (pos) {
        masterPositionsRef.current[updated.name] = pos
        delete masterPositionsRef.current[originalName]
      }
    }
    setEditorState(null)
    applySchema({ ...schema, tables: newTables }, undefined, masterPositionsRef.current)
  }, [schema, applySchema])

  const handleDelete = useCallback(async (tableName: string) => {
    if (!schema) return
    const ok = await dialog.confirm(lang === 'ru' ? 'Удаление таблицы' : 'Delete table', t.deleteConfirm(tableName))
    if (!ok) return
    if (highlightTable === tableName) setHighlightTable(null)
    setSelectedTables(prev => {
      if (!prev.has(tableName)) return prev
      const next = new Set(prev); next.delete(tableName); return next
    })
    const newTables = schema.tables.filter(tb => tb.name !== tableName).map(tb => ({
      ...tb,
      columns: tb.columns.map(c => c.foreignKey?.table === tableName ? { ...c, foreignKey: undefined } : c)
    }))
    applySchema({ ...schema, tables: newTables }, undefined, masterPositionsRef.current)
  }, [schema, applySchema, t, highlightTable, dialog, lang])

  const handleOpen = useCallback((result: OpenResult) => {
    setHighlightTable(null); setSelectedTables(new Set()); setTagFilter(null); setActiveLayoutId(null)
    setCurrentSaveId(result.savedId)
    currentSaveIdRef.current = result.savedId
    currentSaveName.current = result.savedName ?? null
    setFileHandle(result.fileHandle ?? null)
    applySchema(result.schema, undefined, result.positions)
    const hasPositions = result.positions && Object.keys(result.positions).length > 0
    if (!hasPositions) setTimeout(() => setPendingELK(true), 250)
  }, [applySchema])

  if (!schema) {
    return <UploadZone lang={lang} onLangToggle={() => setLang(l => l === 'en' ? 'ru' : 'en')} onOpen={handleOpen} />
  }

  return (
    <div className={appStyles.root}>
      {/* Top bar */}
      <div className={appStyles.topbar}>
        <div className={appStyles.topbarBrand}>
          <Logo size={20} />
          <span className={appStyles.topbarLogo}>TraVis</span>
          <div className={appStyles.topbarBadge}>{schema.tables.length} tables</div>
        </div>
        <div className={appStyles.topbarRight}>
          <button
            onClick={() => { exportJSON(serializeSchema(schema)); dialog.alert(lang === 'ru' ? 'Экспорт JSON' : 'JSON Export', lang === 'ru' ? 'Файл схемы успешно скачан.' : 'The schema file has been successfully downloaded.') }}
            className={appStyles.exportBtn}
          >
            ↓ JSON
          </button>
          <button
            onClick={() => { downloadSQL(schema); dialog.alert(lang === 'ru' ? 'Экспорт SQL' : 'SQL Export', lang === 'ru' ? 'SQL DDL файл успешно скачан.' : 'The SQL DDL file has been successfully downloaded.') }}
            className={appStyles.exportBtn}
          >
            ↓ SQL
          </button>
          <div className={appStyles.divider} />
          <button
            onClick={handleSave}
            className={appStyles.saveBtn}
            style={{ '--save-bg': saveFlash ? '#16a34a' : '#6366f1' } as React.CSSProperties}
          >
            {t.saveBtn}
          </button>
          <button onClick={handleExit} className={appStyles.exitBtn}>{t.exitBtn}</button>
          <button
            onClick={() => setLang(l => l === 'en' ? 'ru' : 'en')}
            className={appStyles.langToggleBtn}
          >
            {lang === 'en' ? 'RU' : 'EN'}
          </button>
        </div>
      </div>

      {/* Content */}
      <div className={appStyles.content}>
          <div className={appStyles.schemaView}>
            {splitView ? (
              <>
                <div className={appStyles.splitEditorPane} style={{ width: editorWidth }}>
                  <SchemaEditor schema={schema} onSchemaChange={handleSchemaFromEditor} onValidityChange={setSchemaValid} width={editorWidth} />
                </div>
                <div className={appStyles.resizeHandle} onMouseDown={handleResizeStart} />
              </>
            ) : (
              <Sidebar
                tables={schema.tables}
                lang={lang}
                onLangToggle={() => setLang(l => l === 'en' ? 'ru' : 'en')}
                onNew={() => setEditorState('new')}
                onEdit={handleEdit}
                onDelete={handleDelete}
                onExit={handleExit}
              />
            )}
            <div className={appStyles.canvasArea}>
              {/* Canvas toolbar */}
              <div className={appStyles.canvasToolbar}>
                {/* Pan / Select */}
                <div className={appStyles.toolPill}>
                  {(['pan', 'select'] as const).map(mode => (
                    <button
                      key={mode}
                      onClick={() => setCanvasMode(mode)}
                      className={`${appStyles.toolBtn} ${canvasMode === mode ? appStyles.toolBtnActive : ''}`}
                      title={mode === 'pan' ? (lang === 'ru' ? 'Режим перемещения' : 'Pan mode') : (lang === 'ru' ? 'Режим выделения (лассо)' : 'Select mode (lasso)')}
                    >
                      <span className={appStyles.toolBtnIcon}>{mode === 'pan' ? '✋' : '⬚'}</span>
                      <span className={appStyles.toolBtnLabel}>{mode}</span>
                    </button>
                  ))}
                </div>

                {/* Groups */}
                <div className={appStyles.groupsPill} ref={groupsBtnRef}>
                  <button
                    onClick={() => setGroupsOpen(!groupsOpen)}
                    className={`${appStyles.groupsBtn} ${tagFilter ? appStyles.groupsBtnFiltered : ''}`}
                  >
                    <span className={appStyles.toolBtnIcon}>◎</span>
                    <span className={appStyles.toolBtnLabel}>
                      {tagFilter ? `#${tagFilter}` : (lang === 'ru' ? 'Группы' : 'Groups')}
                    </span>
                    <span className={appStyles.groupsChevron}>▼</span>
                  </button>
                  {groupsOpen && (
                    <div className={appStyles.groupsDropdown}>
                      <button
                        onClick={() => selectTagGroup(null)}
                        className={`${appStyles.groupsAllBtn} ${tagFilter === null ? appStyles.groupsAllBtnActive : ''}`}
                      >
                        <span>{lang === 'ru' ? 'Все таблицы' : 'All groups'}</span>
                        {tagFilter === null && <span>✓</span>}
                      </button>
                      <div className={appStyles.groupsDivider} />
                      {allTags.map(({ tag, count }) => (
                        <button
                          key={tag}
                          onClick={() => selectTagGroup(tag)}
                          className={`${appStyles.groupsTagBtn} ${tagFilter === tag ? appStyles.groupsTagBtnActive : ''}`}
                        >
                          <div className={appStyles.groupsTagLeft}>
                            <span className={appStyles.groupsTagDot} />
                            <span>{tag}</span>
                          </div>
                          <span className={appStyles.groupsTagCount}>{count}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>

                {/* View mode */}
                <div className={appStyles.toolPill}>
                  <select
                    value={viewMode}
                    onChange={e => handleViewMode(e.target.value as ViewMode)}
                    className={appStyles.viewSelect}
                  >
                    <option value="full">Full</option>
                    <option value="compact">Compact</option>
                    <option value="collapsed">Collapsed</option>
                  </select>
                </div>

                {/* Layouts */}
                <div className={appStyles.groupsPill} ref={layoutsBtnRef}>
                  <button
                    onClick={() => setLayoutsOpen(o => !o)}
                    className={`${appStyles.groupsBtn} ${activeLayout ? appStyles.groupsBtnFiltered : ''}`}
                  >
                    <span className={appStyles.toolBtnIcon}>▦</span>
                    <span className={appStyles.toolBtnLabel}>
                      {activeLayout ? activeLayout.name : (lang === 'ru' ? 'Слои' : 'Layouts')}
                    </span>
                    <span className={appStyles.groupsChevron}>▼</span>
                  </button>
                  {layoutsOpen && (
                    <div className={appStyles.groupsDropdown}>
                      <button
                        onClick={() => selectLayout(null)}
                        className={`${appStyles.groupsAllBtn} ${activeLayoutId === null ? appStyles.groupsAllBtnActive : ''}`}
                      >
                        <span>{lang === 'ru' ? 'Все таблицы' : 'All tables'}</span>
                        {activeLayoutId === null && <span>✓</span>}
                      </button>
                      <div className={appStyles.groupsDivider} />
                      {(schema.layouts ?? []).length === 0 && (
                        <div className={appStyles.layoutEmpty}>
                          {lang === 'ru' ? 'Пока нет слоёв' : 'No layouts yet'}
                        </div>
                      )}
                      {(schema.layouts ?? []).map(l => (
                        <div key={l.id} className={appStyles.layoutRow}>
                          <button
                            onClick={() => selectLayout(l.id)}
                            className={`${appStyles.groupsTagBtn} ${activeLayoutId === l.id ? appStyles.groupsTagBtnActive : ''}`}
                          >
                            <div className={appStyles.groupsTagLeft}>
                              <span>{l.name}</span>
                            </div>
                            <span className={appStyles.groupsTagCount}>{l.tables.length}</span>
                          </button>
                          <button
                            className={appStyles.layoutMenuBtn}
                            onClick={e => { e.stopPropagation(); setLayoutsOpen(false); setLayoutSettingsId(l.id) }}
                            title={lang === 'ru' ? 'Настройки слоя' : 'Layout settings'}
                          >⋯</button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* Organize (ELK) */}
                <div className={appStyles.toolPill}>
                  <button
                    onClick={handleLayout}
                    disabled={layouting}
                    className={`${appStyles.toolBtn} ${layouting ? appStyles.toolBtnDisabled : ''}`}
                    title="Auto-arrange tables (ELK)"
                  >
                    <span className={appStyles.toolBtnIcon} style={layouting ? { display: 'inline-block', transform: 'rotate(90deg)' } : undefined}>⟳</span>
                    <span className={appStyles.toolBtnLabel}>{layouting ? '...' : 'Organize'}</span>
                  </button>
                </div>

                {/* JSON split view */}
                <div className={appStyles.toolPill}>
                  <button
                    onClick={() => { setSplitView(v => !v); setSchemaValid(true) }}
                    className={`${appStyles.toolBtn} ${splitView ? appStyles.toolBtnActive : ''}`}
                    title="Toggle JSON editor"
                  >
                    <span style={{ fontSize: 13, fontFamily: 'monospace', fontWeight: 700 }}>{'{}'}</span>
                    <span className={appStyles.toolBtnLabel}>JSON</span>
                  </button>
                </div>
              </div>

              {/* Create-layout button — appears when a table (or group) is selected */}
              {highlightCtxValue.highlighted.size > 0 && !activeLayout && (
                <button className={appStyles.createLayoutFab} onClick={createLayoutFromSelection}>
                  <span className={appStyles.createLayoutFabIcon}>▦</span>
                  {lang === 'ru' ? 'Создать слой' : 'Create layout'}
                  <span className={appStyles.createLayoutFabCount}>{highlightCtxValue.highlighted.size}</span>
                </button>
              )}

              <ViewModeCtx.Provider value={{ mode: viewMode, bulkExpand, bulkKey }}>
                <HighlightCtx.Provider value={highlightCtxValue}>
                 <EdgeHoverCtx.Provider value={edgeHoverCtxValue}>
                  <MultiSelectCtx.Provider value={multiSelectActive}>
                    <ReactFlow
                      nodes={displayNodes}
                      edges={displayEdges}
                      onNodesChange={handleNodesChange}
                      onEdgesChange={onEdgesChange}
                      onNodeDragStart={handleNodeDragStart}
                      onNodeDrag={handleNodeDrag}
                      onNodeDragStop={handleNodeDragStop}
                      onSelectionChange={handleSelectionChange}
                      onPaneClick={clearHighlight}
                      nodeTypes={NODE_TYPES}
                      edgeTypes={EDGE_TYPES}
                      fitView
                      fitViewOptions={{ padding: 0.2 }}
                      minZoom={0.05}
                      selectionMode={canvasMode === 'select' ? SelectionMode.Partial : SelectionMode.Full}
                      panOnDrag={canvasMode === 'pan'}
                      selectionOnDrag={canvasMode === 'select'}
                      multiSelectionKeyCode={canvasMode === 'select' ? 'Shift' : null}
                      panOnScroll={true}
                      onInit={instance => { rfInstanceRef.current = instance }}
                    >
                      <NodesInitializedFitView rfRef={rfInstanceRef} />
                      <Background color="#1a1d27" gap={20} />
                      <Controls
                        showInteractive={false}
                        className={appStyles.reactFlowControls}
                      />
                      <MiniMap
                        style={{ background: '#13151f', borderRadius: 16, border: '1px solid rgba(255,255,255,0.08)', overflow: 'hidden' }}
                        nodeColor={n => tagColor((n.data as { table?: { tags?: string[] } }).table?.tags)}
                        maskColor="rgba(0,0,0,0.6)"
                      />
                    </ReactFlow>
                  </MultiSelectCtx.Provider>
                 </EdgeHoverCtx.Provider>
                </HighlightCtx.Provider>
              </ViewModeCtx.Provider>

              {/* Canvas frozen while the schema editor has errors */}
              {splitView && !schemaValid && (
                <div className={appStyles.freezeOverlay}>
                  <div className={appStyles.freezeMsg}>
                    ⚠ {lang === 'ru' ? 'Исправьте ошибки схемы в редакторе' : 'Fix schema errors in the editor'}
                  </div>
                </div>
              )}
            </div>
          </div>
      </div>

      {editorState !== null && (() => {
        const editedTable = editorState === 'new' ? null : schema.tables.find(t => t.name === editorState) ?? null
        return <TableEditor key={editorState} table={editedTable} schema={schema} lang={lang} onSave={handleEditorSave} onClose={() => setEditorState(null)} />
      })()}

      {layoutSettingsId !== null && (() => {
        const layout = schema.layouts?.find(l => l.id === layoutSettingsId)
        if (!layout) return null
        return (
          <LayoutSettingsModal
            key={layout.id}
            layout={layout}
            lang={lang}
            onRename={name => renameLayout(layout.id, name)}
            onDelete={() => deleteLayout(layout.id)}
            onClose={() => setLayoutSettingsId(null)}
          />
        )
      })()}
    </div>
  )
}

function LayoutSettingsModal({ layout, lang, onRename, onDelete, onClose }: {
  layout: Layout
  lang: Lang
  onRename: (name: string) => void
  onDelete: () => void
  onClose: () => void
}) {
  const [name, setName] = useState(layout.name)
  const save = () => { onRename(name); onClose() }
  return (
    <div className={appStyles.layoutModalOverlay} onClick={onClose}>
      <div className={appStyles.layoutModal} onClick={e => e.stopPropagation()}>
        <div className={appStyles.layoutModalHeader}>
          <span className={appStyles.layoutModalTitle}>{lang === 'ru' ? 'Настройки слоя' : 'Layout settings'}</span>
          <button className={appStyles.layoutModalClose} onClick={onClose}>×</button>
        </div>
        <label className={appStyles.layoutModalLabel}>{lang === 'ru' ? 'Название' : 'Name'}</label>
        <input
          className={appStyles.layoutModalInput}
          value={name}
          onChange={e => setName(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') save() }}
          autoFocus
        />
        <div className={appStyles.layoutModalMeta}>
          {layout.tables.length} {lang === 'ru' ? 'таблиц' : 'tables'}
        </div>
        <div className={appStyles.layoutModalFooter}>
          <button className={appStyles.layoutModalDelete} onClick={onDelete}>
            {lang === 'ru' ? 'Удалить слой' : 'Delete layout'}
          </button>
          <div className={appStyles.layoutModalFooterRight}>
            <button className={appStyles.layoutModalCancel} onClick={onClose}>{lang === 'ru' ? 'Отмена' : 'Cancel'}</button>
            <button className={appStyles.layoutModalSave} onClick={save}>{lang === 'ru' ? 'Сохранить' : 'Save'}</button>
          </div>
        </div>
      </div>
    </div>
  )
}
