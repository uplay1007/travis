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
  useReactFlow,
  useUpdateNodeInternals,
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
  saveCurrentSession, loadCurrentSession, clearCurrentSession, saveDB,
} from './utils/storage'
import { TableNode, type TableNodeData, MultiSelectCtx } from './components/canvas/TableNode'
import { HighlightCtx, type HighlightCtxValue } from './contexts/highlight'
import { EdgeHoverCtx, type EdgeEndpoint } from './contexts/edgeHover'
import { ViewModeCtx, type ViewMode, type ViewModeCtxValue } from './contexts/viewMode'
import { ThemeCtx } from './contexts/theme'
import { OrthoEdge, type OrthoEdgeData } from './components/canvas/OrthoEdge'
import type { Side } from './utils/orthoRoute'
import { computeELKLayout } from './services/layoutService'
import { resolveOverlaps, type Rect } from './utils/separateNodes'
import { TableEditor } from './components/editor/TableEditor'
import { Sidebar } from './components/shell/Sidebar'
import { SchemaEditor } from './components/editor/SchemaEditor'
import { UploadZone, type OpenResult } from './components/shell/UploadZone'
import { writeToHandle } from './utils/fileAccess'
import { exportSQL } from './utils/parsers/sql'
import { schemaToStructured } from './utils/structuredJSON'
import { exportDrawio, type DrawioPage } from './utils/drawioExport'
import { T, type Lang } from './i18n'
import { DialogProvider, useDialog } from './contexts/DialogContext'
import { Logo } from './components/ui/Logo'
import { ThemeSwitch } from './components/ui/ThemeSwitch'
import appStyles from './App.module.css'

const NODE_TYPES = { table: TableNode }
const EDGE_TYPES = { fk: OrthoEdge }

function NodesInitializedFitView({ rfRef }: {
  rfRef: React.RefObject<ReactFlowInstance<any, any> | null>
}) {
  const initialized = useNodesInitialized()
  const rf = useReactFlow()
  const updateNodeInternals = useUpdateNodeInternals()
  const didFit = useRef(false)
  useEffect(() => {
    if (!initialized) return
    // fit once per mount (fresh schema open); never on later node re-inits (edits)
    if (!didFit.current) {
      didFit.current = true
      rfRef.current?.fitView({ padding: 0.2, duration: 300 })
    }
    // Re-register every node's handles once nodes are measured. On a fast
    // schema swap (exit → open), edges can be committed before React Flow has
    // registered the brand-new nodes' handles, leaving their source/target
    // unresolved so no <path> is drawn — until a manual reopen. Forcing a
    // handle recompute here resolves them without the reopen.
    updateNodeInternals(rf.getNodes().map(n => n.id))
  }, [initialized, rfRef, rf, updateNodeInternals])
  return null
}

function getRelType(table: Table, col: Column): '1:1' | '1:N' | 'N:M' {
  // a primary key is inherently unique in every real database, even when
  // the "unique" flag wasn't also (redundantly) ticked — without this, the
  // most natural way to model a 1:1 (child.id PK+FK -> parent.id) rendered
  // as 1:N instead, with no obvious way to fix it via the UI.
  if (col.unique || col.primaryKey) return '1:1'
  const fkCols = table.columns.filter(c => c.foreignKey)
  if (fkCols.length >= 2 && fkCols.length >= table.columns.length - 1) return 'N:M'
  return '1:N'
}

// Tables whose entire FK-neighborhood (both directions) is just `focus` —
// i.e. connected only to the focused table and to nothing else. Scoped to
// `visibleTables`: a relation to a table outside that set (e.g. hidden by
// the active layout or tag filter) doesn't count against exclusivity —
// exclusivity reflects what's physically on screen, not the full schema.
function exclusiveNeighbors(visibleTables: Table[], focus: string): string[] {
  const visibleNames = new Set(visibleTables.map(t => t.name))
  const result: string[] = []
  for (const t of visibleTables) {
    if (t.name === focus) continue
    const partners = new Set<string>()
    for (const col of t.columns) {
      if (col.foreignKey && col.foreignKey.table !== t.name && visibleNames.has(col.foreignKey.table)) {
        partners.add(col.foreignKey.table)
      }
    }
    for (const other of visibleTables) {
      if (other.name === t.name) continue
      for (const col of other.columns) {
        if (col.foreignKey?.table === t.name) partners.add(other.name)
      }
    }
    if (partners.has(focus) && [...partners].every(p => p === focus)) result.push(t.name)
  }
  return result
}

// The set lit by a plain click: the focused table plus every table joined to it
// by a foreign key in either direction.
function fkNeighborhood(tables: Table[], focus: string): Set<string> {
  const set = new Set<string>([focus])
  for (const t of tables) {
    for (const col of t.columns) {
      if (!col.foreignKey) continue
      if (t.name === focus) set.add(col.foreignKey.table)
      if (col.foreignKey.table === focus) set.add(t.name)
    }
  }
  return set
}

// "Added to Layout 2: users, products и 10 др." — list up to CAP names, then a
// spillover tail, keeping the toast within a few lines.
function addedToLayoutMsg(layoutName: string, names: string[], lang: Lang): string {
  const CAP = 5
  const shown = names.slice(0, CAP)
  const rest = names.length - shown.length
  let list = shown.join(', ')
  if (rest > 0) list += lang === 'ru' ? ` и ещё ${rest}` : ` +${rest} more`
  return lang === 'ru' ? `Добавлено в ${layoutName}: ${list}` : `Added to ${layoutName}: ${list}`
}

// stable empty-set reference so memos/selectors that fall back to "no filter
// set for this view yet" don't manufacture a fresh Set (and a fresh render)
// on every call
const EMPTY_TAG_SET: ReadonlySet<string> = new Set()

interface TableRect { x: number; y: number; width: number; height: number }

// Below this gap, routeOrtho's obstacle clearance (MARGIN=14 each side,
// ESCAPE=60 outer ring — see utils/orthoRoute.ts) doesn't leave a clean
// corridor between the two tables, so a route facing straight across that
// gap ends up hugging one of their borders instead of passing cleanly
// between them.
const SIDE_GAP_CLEARANCE = 60

const SIDES: readonly Side[] = ['top', 'bottom', 'left', 'right']

// The point where a connection touches a given side of a table's box —
// always that side's midpoint. Exactly where along the side an edge is
// actually drawn is decided later, once every edge sharing that side is
// known (see fanOutSideAnchors below).
function sideMidpoint(r: TableRect, side: Side): { x: number; y: number } {
  switch (side) {
    case 'top': return { x: r.x + r.width / 2, y: r.y }
    case 'bottom': return { x: r.x + r.width / 2, y: r.y + r.height }
    case 'left': return { x: r.x, y: r.y + r.height / 2 }
    case 'right': return { x: r.x + r.width, y: r.y + r.height / 2 }
  }
}

// The gap between two tables when sideA/sideB face each other directly
// across a straight corridor (a right→left pair, or a top→bottom pair) —
// null for any other combination, since those don't share a corridor at all.
function facingGap(a: TableRect, b: TableRect, sideA: Side, sideB: Side): number | null {
  if (sideA === 'right' && sideB === 'left') return b.x - (a.x + a.width)
  if (sideA === 'left' && sideB === 'right') return a.x - (b.x + b.width)
  if (sideA === 'bottom' && sideB === 'top') return b.y - (a.y + a.height)
  if (sideA === 'top' && sideB === 'bottom') return a.y - (b.y + b.height)
  return null
}

// Which side of each table an FK edge should connect to — picked purely by
// distance, like a straight ruler between the two boxes: try every one of
// the 4×4 side combinations and keep whichever pair of side-midpoints ends
// up closest together. Inspired by the open-source erd-editor VS Code
// extension's relationship anchoring (see the roadmap doc) — it ignores
// which specific column an edge represents when picking a side, same as
// here; exactly which column an edge is still shows in its hover label, it's
// just no longer where the dot physically sits.
//
// A facing pair (right→left, top→bottom) closer than SIDE_GAP_CLEARANCE is
// disqualified even when it's the shortest distance on paper — the router
// can't keep clear of both borders through a corridor that narrow, so a
// straight shot across a near-touching gap is exactly the case that used to
// clip a table's edge (see the routing gotcha in the roadmap doc).
function pickBestSides(a: TableRect, b: TableRect): { aSide: Side; bSide: Side } {
  let best: { aSide: Side; bSide: Side } = { aSide: 'right', bSide: 'left' }
  let bestDist = Infinity
  for (const aSide of SIDES) {
    for (const bSide of SIDES) {
      const gap = facingGap(a, b, aSide, bSide)
      if (gap !== null && gap < SIDE_GAP_CLEARANCE) continue
      const pa = sideMidpoint(a, aSide)
      const pb = sideMidpoint(b, bSide)
      const dist = Math.hypot(pa.x - pb.x, pa.y - pb.y)
      if (dist < bestDist) { bestDist = dist; best = { aSide, bSide } }
    }
  }
  return best
}

interface EdgeAnchors {
  sourcePoint: { x: number; y: number }
  targetPoint: { x: number; y: number }
  sourceSide: Side
  targetSide: Side
}

// Spreads multiple edges that land on the same side of the same table along
// that side (evenly, like slats in a blind) instead of bunching them at one
// point — and orders them by where each edge's OTHER end sits, so parallel
// lines fan out in the same order they'll eventually run rather than
// crossing right next to the shared table. Same idea as erd-editor's
// relationship-overlay sort.
function fanOutSideAnchors(
  edgeEndpoints: { id: string; sourceId: string; targetId: string }[],
  rects: Map<string, TableRect>,
): Map<string, EdgeAnchors> {
  const sides = new Map<string, { aSide: Side; bSide: Side }>()
  for (const e of edgeEndpoints) {
    const a = rects.get(e.sourceId)
    const b = rects.get(e.targetId)
    if (a && b) sides.set(e.id, pickBestSides(a, b))
  }

  // group every edge-endpoint by which (table, side) it lands on, keeping
  // the far endpoint's un-fanned-out midpoint for ordering
  type Slot = { edgeId: string; end: 'source' | 'target'; otherMid: { x: number; y: number } }
  const groups = new Map<string, Slot[]>()
  const addSlot = (tableId: string, side: Side, slot: Slot) => {
    const key = `${tableId}::${side}`
    const list = groups.get(key)
    if (list) list.push(slot)
    else groups.set(key, [slot])
  }
  for (const e of edgeEndpoints) {
    const pick = sides.get(e.id)
    const a = rects.get(e.sourceId)
    const b = rects.get(e.targetId)
    if (!pick || !a || !b) continue
    addSlot(e.sourceId, pick.aSide, { edgeId: e.id, end: 'source', otherMid: sideMidpoint(b, pick.bSide) })
    addSlot(e.targetId, pick.bSide, { edgeId: e.id, end: 'target', otherMid: sideMidpoint(a, pick.aSide) })
  }

  // for each (table, side) group, spread its slots evenly across that side
  // (never touching the corners), ordered by the other end's position along
  // the axis being spread
  const points = new Map<string, { x: number; y: number }>() // key: `${edgeId}::${end}`
  for (const [key, slots] of groups) {
    const sepIdx = key.lastIndexOf('::')
    const tableId = key.slice(0, sepIdx)
    const side = key.slice(sepIdx + 2) as Side
    const r = rects.get(tableId)
    if (!r) continue
    const vertical = side === 'left' || side === 'right'
    slots.sort((s1, s2) => vertical ? s1.otherMid.y - s2.otherMid.y : s1.otherMid.x - s2.otherMid.x)
    const n = slots.length
    slots.forEach((slot, i) => {
      const t = (i + 1) / (n + 1)
      const x = vertical ? (side === 'left' ? r.x : r.x + r.width) : r.x + r.width * t
      const y = vertical ? r.y + r.height * t : (side === 'top' ? r.y : r.y + r.height)
      points.set(`${slot.edgeId}::${slot.end}`, { x, y })
    })
  }

  const result = new Map<string, EdgeAnchors>()
  for (const e of edgeEndpoints) {
    const pick = sides.get(e.id)
    const sourcePoint = points.get(`${e.id}::source`)
    const targetPoint = points.get(`${e.id}::target`)
    if (!pick || !sourcePoint || !targetPoint) continue
    result.set(e.id, { sourcePoint, targetPoint, sourceSide: pick.aSide, targetSide: pick.bSide })
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
        // placeholder side — displayEdges overrides this per-edge once node
        // geometry is available, based on the two tables' actual positions
        // (see pickBestSides/fanOutSideAnchors).
        sourceHandle: 'right',
        targetHandle: 'left',
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

function withExt(name: string, ext: string): string {
  const trimmed = name.trim()
  if (!trimmed) return `schema.${ext}`
  return trimmed.toLowerCase().endsWith(`.${ext}`) ? trimmed : `${trimmed}.${ext}`
}

function exportJSON(schema: Schema, masterPositions: Record<string, { x: number; y: number }> = {}, filename = 'schema.json') {
  const blob = new Blob([JSON.stringify(schemaToStructured(schema, masterPositions), null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url; a.download = filename; a.click()
  URL.revokeObjectURL(url)
}

function downloadSQL(schema: Schema, filename = 'schema.sql') {
  const sql = exportSQL(schema)
  const blob = new Blob([sql], { type: 'text/plain' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url; a.download = filename; a.click()
  URL.revokeObjectURL(url)
}

export default function App() {
  const [lang, setLang] = useState<Lang>('en')
  const [theme, setTheme] = useState<'dark' | 'light'>(
    () => (localStorage.getItem('travis_theme') === 'light' ? 'light' : 'dark')
  )
  useEffect(() => {
    document.documentElement.dataset.theme = theme
    localStorage.setItem('travis_theme', theme)
  }, [theme])
  const toggleTheme = useCallback(() => setTheme(t => (t === 'dark' ? 'light' : 'dark')), [])

  return (
    <DialogProvider lang={lang}>
      <AppContent lang={lang} setLang={setLang} theme={theme} onThemeToggle={toggleTheme} />
    </DialogProvider>
  )
}

function AppContent({ lang, setLang, theme, onThemeToggle }: {
  lang: Lang
  setLang: React.Dispatch<React.SetStateAction<Lang>>
  theme: 'dark' | 'light'
  onThemeToggle: () => void
}) {
  const session = useMemo(() => loadCurrentSession(), [])
  const dialog = useDialog()

  const [schema, setSchema] = useState<Schema | null>(session?.schema ?? null)
  const [fileHandle, setFileHandle] = useState<FileSystemFileHandle | null>(null)
  // links this session to an entry in the local saves list (utils/storage.ts);
  // null until the first fileless Save prompts for a name, or until a saved
  // project is opened from the main menu's list
  const [currentSaveId, setCurrentSaveId] = useState<string | null>(null)
  const [currentSaveName, setCurrentSaveName] = useState<string | null>(null)

  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([])
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([])
  const nodesRef = useRef<Node[]>([])
  useEffect(() => { nodesRef.current = nodes }, [nodes])

  const masterPositionsRef = useRef<Record<string, { x: number; y: number }>>(session?.positions ?? {})

  const [editorState, setEditorState] = useState<EditorState>(null)
  const [saveFlash, setSaveFlash] = useState(false)

  const rfInstanceRef = useRef<ReactFlowInstance<any, any> | null>(null)
  const groupsBtnRef = useRef<HTMLDivElement>(null)

  const [viewMode, setViewMode] = useState<ViewMode>('full')
  // group-filter selection is independent per view: one Set for the "All
  // tables" canvas, one per layout (see activeTagFilter/viewKey below) —
  // picking a tag while looking at all tables must not silently apply inside
  // a layout too, and each layout keeps its own choice.
  const [baseTagFilter, setBaseTagFilter] = useState<Set<string>>(new Set())
  const [layoutTagFilters, setLayoutTagFilters] = useState<Record<string, Set<string>>>({})
  // tables hidden via the selection toolbar's Hide button — session-only
  // (never persisted/exported/saved), keyed per view for the same reason
  const [hiddenTables, setHiddenTables] = useState<Record<string, Set<string>>>({})
  const [groupsOpen, setGroupsOpen] = useState(false)
  const [activeLayoutId, setActiveLayoutId] = useState<string | null>(null)
  // mirror of activeLayoutId for use inside save callbacks without dep churn
  const activeLayoutIdRef = useRef<string | null>(null)
  useEffect(() => { activeLayoutIdRef.current = activeLayoutId }, [activeLayoutId])
  // per-view key used to scope the tag filter and hidden-table set below
  const viewKey = activeLayoutId ?? '__all__'
  const [layoutsOpen, setLayoutsOpen] = useState(false)
  const [layoutSettingsId, setLayoutSettingsId] = useState<string | null>(null)
  const [addTablesOpen, setAddTablesOpen] = useState(false)
  const [addToLayoutOpen, setAddToLayoutOpen] = useState(false)
  const [toast, setToast] = useState<string | null>(null)
  const toastTimer = useRef<ReturnType<typeof setTimeout>>()
  const showToast = useCallback((msg: string) => {
    setToast(msg)
    clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToast(null), 3500)
  }, [])
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

  // this view's selected group tags and hidden-table set — see
  // baseTagFilter/layoutTagFilters/hiddenTables above for why these are keyed
  // per view instead of being single shared pieces of state
  const activeTagFilter = activeLayoutId ? (layoutTagFilters[activeLayoutId] ?? EMPTY_TAG_SET) : baseTagFilter
  const currentHidden = hiddenTables[viewKey] ?? EMPTY_TAG_SET

  // Table names visible in the current view before the Hide toggle is
  // applied: layout membership (if any) narrowed by that view's selected
  // group tags (OR — matching any one selected tag is enough), or for "All
  // tables" the tag filter alone. `null` means no tag filtering is active.
  const scopedVisibleNames = useMemo(() => {
    if (!schema) return null
    if (activeLayout) {
      if (activeTagFilter.size === 0) return new Set(activeLayout.tables)
      const tableTags = new Map(schema.tables.map(t => [t.name, t.tags ?? []]))
      return new Set(activeLayout.tables.filter(name => tableTags.get(name)?.some(tag => activeTagFilter.has(tag))))
    }
    if (baseTagFilter.size === 0) return null
    return new Set(schema.tables.filter(t => t.tags?.some(tag => baseTagFilter.has(tag))).map(t => t.name))
  }, [schema, activeLayout, activeTagFilter, baseTagFilter])

  // The position a node is actually showing right now, mirroring displayNodes'
  // per-view source of truth. Drag math (group-drag origins, overlap rects)
  // must read this — not the raw node.position — because the base `nodes`
  // array only holds master/all-tables coordinates; a table's layout-specific
  // position lives in layoutPosRef and is otherwise applied at render time only.
  const resolvedPosition = useCallback((n: Node): { x: number; y: number } => {
    if (activeLayout) return layoutPosRef.current[activeLayout.id]?.[n.id] ?? n.position
    if (baseTagFilter.size === 0) return masterPositionsRef.current[n.id] ?? n.position
    return n.position
  }, [activeLayout, baseTagFilter])

  const displayNodes = useMemo(() => {
    if (activeLayout) {
      const pos = layoutPosRef.current[activeLayout.id] ?? {}
      return nodes.map(n => ({
        ...n,
        hidden: !scopedVisibleNames?.has(n.id) || currentHidden.has(n.id),
        position: pos[n.id] ?? n.position,
      }))
    }
    if (!scopedVisibleNames) {
      return nodes.map(n => ({
        ...n,
        hidden: currentHidden.has(n.id),
        position: masterPositionsRef.current[n.id] ?? n.position
      }))
    }
    return nodes.map(n => ({ ...n, hidden: !scopedVisibleNames.has(n.id) || currentHidden.has(n.id) }))
  }, [nodes, scopedVisibleNames, currentHidden, activeLayout])

  const displayEdges = useMemo(() => {
    let visibleEdges = edges
    if (scopedVisibleNames) {
      visibleEdges = visibleEdges.filter(e => scopedVisibleNames.has(e.source) && scopedVisibleNames.has(e.target))
    }
    if (currentHidden.size > 0) {
      visibleEdges = visibleEdges.filter(e => !currentHidden.has(e.source) && !currentHidden.has(e.target))
    }

    // re-pick each edge's connection side and exact anchor point against the
    // tables' current positions (drag, layout switch, Organize, ...) — see
    // pickBestSides/fanOutSideAnchors
    const rects = new Map<string, TableRect>()
    for (const n of displayNodes) {
      const m = n.measured as { width?: number; height?: number } | undefined
      rects.set(n.id, { x: n.position.x, y: n.position.y, width: m?.width ?? 280, height: m?.height ?? 120 })
    }
    const anchors = fanOutSideAnchors(
      visibleEdges.map(e => ({ id: e.id, sourceId: e.source, targetId: e.target })),
      rects,
    )
    return visibleEdges.map(e => {
      const a = anchors.get(e.id)
      if (!a) return e
      return {
        ...e,
        sourceHandle: a.sourceSide,
        targetHandle: a.targetSide,
        data: {
          ...(e.data as OrthoEdgeData),
          sourcePoint: a.sourcePoint,
          targetPoint: a.targetPoint,
          sourceSide: a.sourceSide,
          targetSide: a.targetSide,
        } satisfies OrthoEdgeData,
      }
    })
  }, [edges, scopedVisibleNames, currentHidden, displayNodes])

  // React Flow's native selection (marquee, click, shift-click) is the single
  // source of truth. A multi-selection becomes the highlighted group; a single
  // selected table focuses it and lights up its FK-connected neighbors. Either
  // way the previous highlight is replaced, so a stale one can't linger under a
  // fresh marquee.
  const handleSelectionChange = useCallback(({ nodes: sel }: OnSelectionChangeParams) => {
    const ids = sel.map(n => n.id)
    // XYFlow's own drag machinery force-clears native selection (fires this with
    // an empty array) at the start of any drag on a node it doesn't consider
    // selected — which is every Alt/Cmd-highlighted node, since that selection
    // lives in our own selectedTables/highlightTable state, never in React
    // Flow's native `selected`. Ignoring the empty case here keeps our manual
    // group intact through a drag; real "clear everything" already goes
    // through onPaneClick.
    if (ids.length === 0) return
    setMultiSelectActive(ids.length > 1)
    if (ids.length > 1) {
      setSelectedTables(new Set(ids))
      setHighlightTable(null)
    } else {
      setSelectedTables(new Set())
      setHighlightTable(ids[0] ?? null)
    }
  }, [])

  // A plain click on a table that's already part of a multi-selection drops
  // just it out of the group. React Flow keeps a clicked member selected on
  // its own (so the group stays draggable) and its mousedown handler is a
  // no-op for an already-selected member — so nodesRef still holds the whole
  // group here. Cmd/Ctrl/Alt clicks are handled by React Flow / handleTableClick.
  const handleNodeClick = useCallback((e: React.MouseEvent, node: Node) => {
    if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return
    const selected = nodesRef.current.filter(n => n.selected)
    if (selected.length > 1 && selected.some(n => n.id === node.id)) {
      setNodes(nds => nds.map(n => n.id === node.id ? { ...n, selected: false } : n))
    }
  }, [setNodes])

  // Tags shown in the Groups dropdown, scoped to the current view: every tag
  // in the schema for "All tables", or only tags actually used by this
  // layout's own tables when a layout is active — checking a tag that
  // matches nothing in the current layout would be a dead control.
  const scopedTags = useMemo(() => {
    if (!schema) return []
    const source = activeLayout
      ? schema.tables.filter(t => activeLayout.tables.includes(t.name))
      : schema.tables
    const counts: Record<string, number> = {}
    for (const t of source) {
      for (const tag of (t.tags ?? [])) counts[tag] = (counts[tag] ?? 0) + 1
    }
    return Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([tag, count]) => ({ tag, count }))
  }, [schema, activeLayout])

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

  // Toggle one tag's membership in the current view's filter set (OR
  // semantics: a table shows if it matches ANY checked tag). "All tables" and
  // each layout keep independent sets — see baseTagFilter/layoutTagFilters.
  const toggleActiveTag = useCallback((tag: string) => {
    if (activeLayoutId) {
      setLayoutTagFilters(prev => {
        const next = new Set(prev[activeLayoutId] ?? [])
        if (next.has(tag)) next.delete(tag); else next.add(tag)
        return { ...prev, [activeLayoutId]: next }
      })
    } else {
      setBaseTagFilter(prev => {
        const next = new Set(prev)
        if (next.has(tag)) next.delete(tag); else next.add(tag)
        return next
      })
    }
  }, [activeLayoutId])

  // "All groups" row — clears this view's filter back to showing everything
  const clearActiveTagFilter = useCallback(() => {
    if (activeLayoutId) {
      setLayoutTagFilters(prev => {
        if (!prev[activeLayoutId]?.size) return prev
        const next = { ...prev }
        delete next[activeLayoutId]
        return next
      })
    } else {
      setBaseTagFilter(new Set())
    }
  }, [activeLayoutId])

  // Re-arrange into a compact ELK layout whenever the "All tables" tag
  // filter changes — only for that view: inside a layout the tag filter is a
  // pure show/hide toggle (like Hide below), since the user's own manual
  // arrangement there should never get silently rearranged by a filter click.
  const baseTagKey = useMemo(() => JSON.stringify([...baseTagFilter].sort()), [baseTagFilter])
  const prevBaseTagKeyRef = useRef<string>(baseTagKey)
  useEffect(() => {
    if (!schema || activeLayoutId) return
    // only re-frame when the tag selection actually changed — not on content/viewMode edits
    const tagChanged = prevBaseTagKeyRef.current !== baseTagKey
    prevBaseTagKeyRef.current = baseTagKey
    setHighlightTable(null)

    if (baseTagFilter.size === 0) {
      if (Object.keys(masterPositionsRef.current).length > 0) {
        setNodes(prev => prev.map(n => ({
          ...n,
          position: masterPositionsRef.current[n.id] ?? n.position,
        })))
      }
      if (tagChanged) setTimeout(() => rfInstanceRef.current?.fitView({ padding: 0.2, duration: 400 }), 50)
      return
    }

    const visibleNames = new Set(schema.tables.filter(t => t.tags?.some(tag => baseTagFilter.has(tag))).map(t => t.name))
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
  }, [baseTagKey, baseTagFilter, schema, setNodes, viewMode, activeLayoutId])

  const clearHighlight = useCallback(() => {
    setHighlightTable(null)
    setSelectedTables(new Set())
  }, [])

  // Click a table header. Plain click goes through React Flow's native
  // selection (select-one), mirrored into highlightTable/FK-focus by
  // handleSelectionChange. Cmd and Alt build their own group in the app
  // state instead — both are kept out of React Flow's native selection (see
  // TableNode's handleHeaderClick) so they don't get flattened into whatever
  // 1-or-2-node set React Flow happens to have selected.
  const handleTableClick = useCallback((name: string, mods: { cmd: boolean; alt: boolean; shift: boolean }) => {
    if (mods.cmd) {
      // Toggle exactly the clicked table's membership in the current group —
      // never its own neighbours. The first cmd-click seeds the group from
      // the focused table's FK-neighbourhood (so those neighbours stay lit
      // instead of collapsing down to just the two tables involved).
      setSelectedTables(prev => {
        const next = prev.size > 0
          ? new Set(prev)
          : (highlightTable && schema ? fkNeighborhood(schema.tables, highlightTable) : new Set<string>())
        if (next.has(name)) next.delete(name)
        else next.add(name)
        return next
      })
      return
    }
    if (mods.shift) {
      // Promote this table's FK-neighbourhood — the same set a plain click
      // already lights up for visual context — into a real selectedTables
      // group (groupMode: true), so it becomes an explicit, draggable-
      // together group (see handleNodeDragStart/handleNodeDrag's groupMode
      // gate). Sets the group outright rather than toggling like Cmd does —
      // one shift-click grabs "this whole connected cluster".
      if (!schema) return
      setHighlightTable(null)
      setSelectedTables(fkNeighborhood(schema.tables, name))
      return
    }
    if (!mods.alt || !schema) return
    const visibleTables = schema.tables.filter(t =>
      (!scopedVisibleNames || scopedVisibleNames.has(t.name)) && !currentHidden.has(t.name)
    )
    // Set the group directly rather than through React Flow selection: with no
    // exclusive satellites this is just the clicked table, and routing a
    // single-node selection through handleSelectionChange would turn it into an
    // FK-focus that lights up the table's neighbours — exactly what Alt should
    // NOT do. selectedTables takes precedence in highlightCtxValue, so only the
    // focus + its exclusive satellites light up.
    setHighlightTable(name)
    setSelectedTables(new Set([name, ...exclusiveNeighbors(visibleTables, name)]))
  }, [schema, scopedVisibleNames, currentHidden, highlightTable])

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
    const set = fkNeighborhood(schema.tables, highlightTable)
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
      } else if (baseTagFilter.size === 0) {
        masterPositionsRef.current = { ...positions }
      }
      setNodes(prev => prev.map(n => ({ ...n, position: positions[n.id] ?? n.position })))
      // save immediately — Organize is a deliberate "commit this result" action,
      // so it can't be left to the 1s drag-debounced autosave: a reload before
      // that timer fires would silently revert to the pre-Organize positions
      const schemaOut = schema.layouts?.length
        ? { ...schema, layouts: schema.layouts.map(l => ({ ...l, positions: layoutPosRef.current[l.id] ?? l.positions })) }
        : schema
      saveCurrentSession({ schema: schemaOut, positions: masterPositionsRef.current, activeLayoutId: activeLayoutIdRef.current })
      // re-frame the camera on the freshly arranged tables
      setTimeout(() => rfInstanceRef.current?.fitView({ padding: 0.2, duration: 400 }), 60)
    } catch (err) {
      console.error('ELK layout failed:', err)
    } finally {
      setLayouting(false)
    }
  }, [schema, layouting, setNodes, baseTagFilter, viewMode, activeLayout])

  useEffect(() => {
    if (!pendingELK || layouting || nodes.length === 0) return
    const visibleNodes = baseTagFilter.size > 0 && schema
      ? nodes.filter(n => schema.tables.find(t => t.name === n.id)?.tags?.some(tag => baseTagFilter.has(tag)))
      : nodes
    if (visibleNodes.length === 0) return
    const measuredCount = visibleNodes.filter(n => (n.measured as { height?: number } | undefined)?.height).length
    if (measuredCount < visibleNodes.length) return
    setPendingELK(false)
    handleLayout()
  }, [pendingELK, nodes, layouting, handleLayout, baseTagFilter, schema])

  // persist a dragged position to the active view: layout ref, else master
  // (tag-filter view is ephemeral — no persistence)
  const persistPos = useCallback((id: string, pos: { x: number; y: number }) => {
    if (activeLayoutId) {
      (layoutPosRef.current[activeLayoutId] ??= {})[id] = pos
    } else if (baseTagFilter.size === 0) {
      // fresh object (not an in-place mutation) so consumers that only
      // re-render on reference change (e.g. the JSON editor's live preview
      // of master positions) actually pick up the drag
      masterPositionsRef.current = { ...masterPositionsRef.current, [id]: pos }
    }
  }, [activeLayoutId, baseTagFilter])

  const handleNodesChange = useCallback((changes: NodeChange[]) => {
    onNodesChange(changes)
    changes.forEach(c => {
      if (c.type === 'position' && c.position) persistPos(c.id, c.position)
    })
  }, [onNodesChange, persistPos])

  const groupDragOrigins = useRef<Record<string, { x: number; y: number }>>({})

  // Group-dragging only kicks in for an EXPLICIT multi-select (Cmd-click,
  // Alt-click, marquee — highlightCtxValue.groupMode / selectedTables), never
  // for the passive FK-neighbourhood highlight a plain single click lights up
  // (highlighted still includes those neighbours then, but groupMode is
  // false). Gating on `highlighted` alone used to mean grabbing a table that
  // merely had lit-up neighbours dragged them all along with it — a plain
  // click was supposed to move only the one table you grabbed.
  const handleNodeDragStart = useCallback((_e: MouseEvent | TouchEvent, node: Node) => {
    if (!highlightCtxValue.groupMode || !highlightCtxValue.highlighted.has(node.id)) return
    groupDragOrigins.current = Object.fromEntries(
      nodes
        .filter(n => highlightCtxValue.highlighted.has(n.id))
        .map(n => [n.id, resolvedPosition(n)])
    )
  }, [highlightCtxValue.groupMode, highlightCtxValue.highlighted, nodes, resolvedPosition])

  const handleNodeDrag = useCallback((_e: MouseEvent | TouchEvent, node: Node) => {
    const isGroupDrag = highlightCtxValue.groupMode && highlightCtxValue.highlighted.has(node.id)

    persistPos(node.id, { x: node.position.x, y: node.position.y })

    if (!isGroupDrag) return
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
  }, [highlightCtxValue.groupMode, highlightCtxValue.highlighted, setNodes, persistPos])

  const handleNodeDragStop = useCallback((_e: MouseEvent | TouchEvent, node: Node) => {
    const current = nodesRef.current
    if (current.length === 0) return

    // in a layout, only its visible tables take part in overlap resolution
    const visibleSet = activeLayout ? new Set(activeLayout.tables) : null

    const rects = new Map<string, Rect>()
    for (const n of current) {
      if (visibleSet && !visibleSet.has(n.id)) continue
      const m = n.measured as { width?: number; height?: number } | undefined
      const p = resolvedPosition(n)
      rects.set(n.id, { x: p.x, y: p.y, w: m?.width ?? 280, h: m?.height ?? 120 })
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
  }, [setNodes, persistPos, activeLayout, resolvedPosition])

  // ── Layouts ────────────────────────────────────────────────────────────
  const selectLayout = useCallback((id: string | null) => {
    setActiveLayoutId(id)
    setHighlightTable(null); setSelectedTables(new Set())
    setLayoutsOpen(false)
    // restore this view's saved detail level
    const mode = id ? (schema?.layouts?.find(l => l.id === id)?.viewMode ?? 'full') : baseViewMode
    applyViewMode(mode)
    setTimeout(() => rfInstanceRef.current?.fitView({ padding: 0.2, duration: 400 }), 60)
  }, [schema, baseViewMode, applyViewMode])

  // Shared by both entry points: the "Create layout" FAB (current selection)
  // and the "+ Create layout" row in the Layouts dropdown (no selection
  // needed — starts an empty layout the user then adds tables to).
  const createLayout = useCallback((tables: string[]) => {
    if (!schema) return
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
    setLayoutsOpen(false)
    setActiveLayoutId(id)
    if (tables.length > 0) {
      setTimeout(() => rfInstanceRef.current?.fitView({ padding: 0.2, duration: 400 }), 60)
    }
  }, [schema, viewMode])

  const createLayoutFromSelection = useCallback(() => {
    const tables = [...highlightCtxValue.highlighted]
    if (tables.length === 0) return
    createLayout(tables)
  }, [highlightCtxValue.highlighted, createLayout])

  // Add tables to a layout (the active one by default, or `targetLayoutId` for
  // a cross-layout add): tables already in the target are skipped; existing
  // ones keep their positions (pinned); genuinely new ones get a compact ELK
  // layout among themselves, offset to sit beside the existing cluster, then
  // nudged clear of any overlap.
  const addTablesToLayout = useCallback(async (names: string[], targetLayoutId?: string) => {
    const target = targetLayoutId ? schema?.layouts?.find(l => l.id === targetLayoutId) : activeLayout
    if (!target || !schema) return
    const newNames = names.filter(n => !target.tables.includes(n))
    if (newNames.length === 0) return

    const heights: Record<string, number> = {}
    nodesRef.current.forEach(n => {
      const h = (n.measured as { height?: number } | undefined)?.height
      if (h) heights[n.id] = h
    })

    const { positions: newPositions } = await computeELKLayout(schema, heights, new Set(newNames))

    const existingPos = layoutPosRef.current[target.id] ?? {}
    let maxX = 0, minY = 0, any = false
    for (const name of target.tables) {
      const p = existingPos[name]
      if (!p) continue
      const w = (nodesRef.current.find(n => n.id === name)?.measured as { width?: number } | undefined)?.width ?? 280
      maxX = any ? Math.max(maxX, p.x + w) : p.x + w
      minY = any ? Math.min(minY, p.y) : p.y
      any = true
    }
    const offsetX = any ? maxX + 200 : 0
    const offsetY = any ? minY : 0

    const rects = new Map<string, Rect>()
    for (const name of target.tables) {
      const p = existingPos[name]
      if (!p) continue
      const m = nodesRef.current.find(n => n.id === name)?.measured as { width?: number; height?: number } | undefined
      rects.set(name, { x: p.x, y: p.y, w: m?.width ?? 280, h: m?.height ?? 120 })
    }
    for (const name of newNames) {
      const p = newPositions[name]
      if (!p) continue
      rects.set(name, { x: p.x + offsetX, y: p.y + offsetY, w: 280, h: heights[name] ?? 160 })
    }

    const resolved = resolveOverlaps(rects, new Set(target.tables))
    const posMap = { ...existingPos }
    for (const name of newNames) {
      const p = resolved.get(name)
      if (p) posMap[name] = p
    }
    layoutPosRef.current[target.id] = posMap

    setSchema({
      ...schema,
      layouts: schema.layouts!.map(l => l.id === target.id ? { ...l, tables: [...l.tables, ...newNames] } : l),
    })
    showToast(addedToLayoutMsg(target.name, newNames, lang))
    if (target.id === activeLayout?.id) {
      setAddTablesOpen(false)
      setTimeout(() => rfInstanceRef.current?.fitView({ padding: 0.2, duration: 400 }), 60)
    }
  }, [activeLayout, schema, showToast, lang])

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

  const toggleLayoutLock = useCallback((id: string) => {
    if (!schema) return
    setSchema({ ...schema, layouts: (schema.layouts ?? []).map(l => l.id === id ? { ...l, locked: !l.locked } : l) })
  }, [schema])

  // ── Selection toolbar: Hide / Show / Delete-from-layout ─────────────────
  // Hide/Show are session-only (never persisted) and scoped to the current
  // view via viewKey, same as the group-tag filters above — hiding a table
  // while looking at Layout A must not also hide it in Layout B or "All
  // tables". Delete-from-layout only removes membership in the active
  // layout's own table list; the table itself (and any other layout it's in)
  // is untouched.
  const hideSelected = useCallback(() => {
    const ids = [...highlightCtxValue.highlighted]
    if (ids.length === 0) return
    setHiddenTables(prev => {
      const next = new Set(prev[viewKey] ?? [])
      ids.forEach(id => next.add(id))
      return { ...prev, [viewKey]: next }
    })
    setSelectedTables(new Set()); setHighlightTable(null)
  }, [highlightCtxValue.highlighted, viewKey])

  const showHiddenTables = useCallback(() => {
    setHiddenTables(prev => {
      if (!prev[viewKey]?.size) return prev
      const next = { ...prev }
      delete next[viewKey]
      return next
    })
  }, [viewKey])

  const deleteSelectedFromLayout = useCallback(() => {
    if (!schema || !activeLayout) return
    const ids = new Set(highlightCtxValue.highlighted)
    if (ids.size === 0) return
    const posMap = layoutPosRef.current[activeLayout.id]
    if (posMap) ids.forEach(id => delete posMap[id])
    setSchema({
      ...schema,
      layouts: schema.layouts!.map(l => l.id === activeLayout.id ? { ...l, tables: l.tables.filter(name => !ids.has(name)) } : l),
    })
    setSelectedTables(new Set()); setHighlightTable(null)
    showToast(lang === 'ru' ? `Удалено из лэйаута: ${ids.size}` : `Removed from layout: ${ids.size}`)
  }, [schema, activeLayout, highlightCtxValue.highlighted, lang, showToast])

  const t = T[lang]
  const handleEdit = useCallback((table: Table) => setEditorState(table.name), [])

  // refresh layouts' stored positions from the live ref before persisting
  const serializeSchema = useCallback((s: Schema): Schema => {
    if (!s.layouts?.length) return s
    return { ...s, layouts: s.layouts.map(l => ({ ...l, positions: layoutPosRef.current[l.id] ?? l.positions })) }
  }, [])

  // Export the whole schema to a draw.io file — one page per TraVis layout
  // plus an "All tables" page, switchable as tabs in draw.io (like sheets in
  // a spreadsheet), each keeping that view's own table set and positions.
  const handleExportDrawio = useCallback((filename = 'schema.drawio') => {
    if (!schema) return
    const schemaOut = serializeSchema(schema)
    const pages: DrawioPage[] = [
      {
        name: lang === 'ru' ? 'Все таблицы' : 'All tables',
        tables: schemaOut.tables,
        positions: masterPositionsRef.current,
      },
      ...(schemaOut.layouts ?? []).map(l => ({
        name: l.name,
        tables: schemaOut.tables.filter(t => l.tables.includes(t.name)),
        positions: l.positions,
      })),
    ]
    const blob = new Blob([exportDrawio(pages)], { type: 'application/xml' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    a.click()
    URL.revokeObjectURL(url)
  }, [schema, serializeSchema, lang])

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
    saveCurrentSession({ schema: schemaToUse, positions: masterPositionsRef.current, activeLayoutId: activeLayoutIdRef.current })
    const { nodes: n, edges: e } = schemaToFlow(schemaToUse, handleEdit, masterPositionsRef.current, currentNodes)
    setNodes(n)
    setEdges(e)
  }, [handleEdit, setNodes, setEdges])

  const handleSchemaFromEditor = useCallback((newSchema: Schema, masterPositions?: Record<string, { x: number; y: number }>) => {
    // the editor's text is the new ground truth for any positions it touched —
    // override the live per-layout cache so applySchema's "keep live edits"
    // fallback (meant to protect in-session drags on reopen) doesn't clobber
    // what was just typed with stale in-memory values
    for (const l of newSchema.layouts ?? []) {
      layoutPosRef.current[l.id] = { ...l.positions }
    }
    applySchema(newSchema, undefined, masterPositions ?? masterPositionsRef.current)
  }, [applySchema])

  useEffect(() => {
    if (session) {
      applySchema(session.schema, undefined, session.positions)
      // restore the layout the user was viewing before the reload
      const savedLayout = session.activeLayoutId
        ? session.schema.layouts?.find(l => l.id === session.activeLayoutId)
        : null
      if (savedLayout) {
        setActiveLayoutId(savedLayout.id)
        applyViewMode(savedLayout.viewMode ?? 'full')
        setTimeout(() => rfInstanceRef.current?.fitView({ padding: 0.2, duration: 400 }), 150)
      }
      // auto-arrange only if the view actually being shown (the restored layout,
      // or the all-tables view) has no positions yet — session.positions is always
      // the all-tables ones, which says nothing about a just-restored layout
      const shownPositions = savedLayout ? savedLayout.positions : session.positions
      const hasPositions = shownPositions && Object.keys(shownPositions).length > 0
      if (!hasPositions) setTimeout(() => setPendingELK(true), 250)
    }
  }, [session, applySchema, applyViewMode])

  // immediate, un-debounced session save — used right after a computed
  // (non-drag) position change, e.g. Organize, so a fast reload can't race
  // past the drag-debounced autosave below and revert to a stale snapshot
  const persistSessionNow = useCallback(() => {
    if (!schema) return
    saveCurrentSession({ schema: serializeSchema(schema), positions: masterPositionsRef.current, activeLayoutId: activeLayoutIdRef.current })
  }, [schema, serializeSchema])

  const dragSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (nodes.length === 0 || !schema) return
    dragSaveTimerRef.current = setTimeout(() => {
      dragSaveTimerRef.current = null
      persistSessionNow()
    }, 1000)
    return () => { if (dragSaveTimerRef.current) clearTimeout(dragSaveTimerRef.current) }
  }, [nodes, schema, persistSessionNow])

  // flush a still-pending drag autosave before the tab actually closes or
  // reloads — otherwise dragging a table and reloading within the 1s debounce
  // window loses that position (same class of bug as the JSON/DSL editor's
  // flush-on-unmount, just for canvas drags instead of typed edits)
  useEffect(() => {
    const flush = () => {
      if (dragSaveTimerRef.current) {
        clearTimeout(dragSaveTimerRef.current)
        dragSaveTimerRef.current = null
        persistSessionNow()
      }
    }
    window.addEventListener('beforeunload', flush)
    window.addEventListener('pagehide', flush)
    return () => {
      window.removeEventListener('beforeunload', flush)
      window.removeEventListener('pagehide', flush)
    }
  }, [persistSessionNow])

  // Save = write back to the open file handle if there is one, AND always
  // mirror into the local saves list (utils/storage.ts) so the project shows
  // up in the main menu's "Recent projects" on next Exit — regardless of
  // whether it's a fileless project or one opened from disk. Name comes from
  // the file's own name when there's a handle (no prompt); otherwise it's
  // asked once, the first Save of the session, then reused on every later
  // Save via currentSaveId.
  const handleSave = useCallback(async () => {
    if (!schema) return
    const schemaOut = serializeSchema(schema)
    let name = currentSaveName

    if (fileHandle) {
      const isSql  = fileHandle.name.endsWith('.sql')
      const isJson = fileHandle.name.endsWith('.json')
      if (!isSql && !isJson) {
        exportJSON(schemaOut, masterPositionsRef.current)
        dialog.alert(
          lang === 'ru' ? 'Формат файла' : 'File format',
          lang === 'ru'
            ? `Файл "${fileHandle.name}" нельзя перезаписать (формат не поддерживает экспорт). Схема скачана как JSON.`
            : `"${fileHandle.name}" cannot be overwritten (export not supported for this format). Schema downloaded as JSON.`
        )
        return
      }
      try {
        const content = isSql ? exportSQL(schemaOut) : JSON.stringify(schemaToStructured(schemaOut, masterPositionsRef.current), null, 2)
        await writeToHandle(fileHandle, content)
      } catch (e) {
        console.warn('File write failed, falling back to download', e)
        exportJSON(schemaOut, masterPositionsRef.current)
        dialog.alert(
          lang === 'ru' ? 'Ошибка записи' : 'Write failed',
          lang === 'ru' ? 'Не удалось сохранить в файл. Схема скачана как копия.' : 'Could not write to file. Schema downloaded as a copy instead.'
        )
        return
      }
      name = name ?? fileHandle.name.replace(/\.[^.]+$/, '')
    } else if (!currentSaveId) {
      const promptedName = await dialog.prompt(
        lang === 'ru' ? 'Имя проекта' : 'Project name',
        lang === 'ru' ? 'Введите имя для сохранения в списке проектов' : 'Enter a name to save this project under',
        schema.tables[0]?.name ?? (lang === 'ru' ? 'Без названия' : 'Untitled')
      )
      if (promptedName === null) return
      name = promptedName.trim() || (lang === 'ru' ? 'Без названия' : 'Untitled')
    }

    const entry = saveDB(name!, schemaOut, masterPositionsRef.current, currentSaveId ?? undefined)
    setCurrentSaveId(entry.id)
    setCurrentSaveName(entry.name)

    setSaveFlash(true)
    setTimeout(() => setSaveFlash(false), 1500)
    dialog.alert(lang === 'ru' ? 'Сохранение' : 'Saved', lang === 'ru' ? 'Изменения успешно сохранены!' : 'All changes have been successfully saved.')
  }, [schema, fileHandle, dialog, lang, serializeSchema, currentSaveId, currentSaveName])

  // asks for a filename before an export download; returns null if the user cancels
  const promptFilename = useCallback(async (ext: string, defaultName: string) => {
    const name = await dialog.prompt(
      lang === 'ru' ? 'Имя файла' : 'Filename',
      lang === 'ru' ? 'Введите имя файла для экспорта' : 'Enter a filename for the export',
      defaultName
    )
    return name === null ? null : withExt(name, ext)
  }, [dialog, lang])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); handleSave() }
      if (e.key === 'Escape') clearHighlight()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [handleSave, clearHighlight])

  const handleExit = useCallback(() => {
    clearCurrentSession(); setSchema(null)
    setFileHandle(null); setBaseTagFilter(new Set()); setLayoutTagFilters({}); setHiddenTables({})
    setActiveLayoutId(null); setEditorState(null)
    setCurrentSaveId(null); setCurrentSaveName(null)
  }, [])

  const handleEditorSave = useCallback((updated: Table, originalName: string | null) => {
    if (!schema) return
    let newTables: Table[]
    if (originalName === null) {
      newTables = [...schema.tables, updated]
    } else {
      const oldName = originalName
      const newName = updated.name
      // detect a single renamed column (by name-set diff against the
      // pre-edit table) so FKs from other tables pointing at the old column
      // name get fixed up too — otherwise they keep pointing at a column
      // that no longer exists and their edge just silently vanishes from
      // the canvas (React Flow can't render an edge to a missing handle),
      // with no warning unless the JSON/DSL panel happens to be open.
      // Ambiguous with multiple simultaneous renames in one save, same
      // one-change assumption the table-rename fixup below already makes.
      const oldTable = schema.tables.find(tb => tb.name === oldName)
      let colRename: { from: string; to: string } | null = null
      if (oldTable) {
        const oldNames = new Set(oldTable.columns.map(c => c.name))
        const newNames = new Set(updated.columns.map(c => c.name))
        const removed = [...oldNames].filter(n => !newNames.has(n))
        const added = [...newNames].filter(n => !oldNames.has(n))
        if (removed.length === 1 && added.length === 1) colRename = { from: removed[0], to: added[0] }
      }
      newTables = schema.tables.map(tb => {
        if (tb.name === oldName) return updated
        if (oldName === newName && !colRename) return tb
        return {
          ...tb,
          columns: tb.columns.map(c => {
            if (c.foreignKey?.table !== oldName) return c
            const column = colRename && c.foreignKey.column === colRename.from ? colRename.to : c.foreignKey.column
            return { ...c, foreignKey: { table: newName, column } }
          }),
        }
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
    setHighlightTable(null); setSelectedTables(new Set())
    setBaseTagFilter(new Set()); setLayoutTagFilters({}); setHiddenTables({})
    setActiveLayoutId(null)
    setFileHandle(result.fileHandle ?? null)
    setCurrentSaveId(result.saveId ?? null)
    setCurrentSaveName(result.saveName ?? null)
    // a JSON export's "All tables" entry is the master view's own positions,
    // not a real named layout — pull it back out before it's treated as one
    const allTablesLayout = result.schema.layouts?.find(l => l.name === 'All tables')
    const remaining = allTablesLayout ? result.schema.layouts!.filter(l => l !== allTablesLayout) : undefined
    const schemaToOpen = allTablesLayout ? { ...result.schema, layouts: remaining!.length ? remaining : undefined } : result.schema
    const positions = allTablesLayout?.positions ?? result.positions
    applySchema(schemaToOpen, undefined, positions)
    const hasPositions = positions && Object.keys(positions).length > 0
    if (!hasPositions) setTimeout(() => setPendingELK(true), 250)
  }, [applySchema])

  if (!schema) {
    return <UploadZone lang={lang} theme={theme} onThemeToggle={onThemeToggle} onOpen={handleOpen} />
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

        {/* Canvas toolbar — groups, view mode, layouts, organize, JSON split */}
        <div className={appStyles.canvasToolbar}>

          {/* Groups — multi-select checkboxes, OR-filtered, scoped + independent per view (see scopedTags/activeTagFilter) */}
          <div className={appStyles.groupsPill} ref={groupsBtnRef}>
            <button
              onClick={() => setGroupsOpen(!groupsOpen)}
              className={`${appStyles.groupsBtn} ${activeTagFilter.size > 0 ? appStyles.groupsBtnFiltered : ''}`}
            >
              <span className={appStyles.toolBtnIcon}>◎</span>
              <span className={appStyles.toolBtnLabel}>
                {activeTagFilter.size === 1
                  ? `#${[...activeTagFilter][0]}`
                  : activeTagFilter.size > 1
                  ? (lang === 'ru' ? `Групп: ${activeTagFilter.size}` : `${activeTagFilter.size} groups`)
                  : (lang === 'ru' ? 'Группы' : 'Groups')}
              </span>
              <span className={appStyles.groupsChevron}>▼</span>
            </button>
            {groupsOpen && (
              <div className={appStyles.groupsDropdown}>
                <button
                  onClick={clearActiveTagFilter}
                  className={`${appStyles.groupsAllBtn} ${activeTagFilter.size === 0 ? appStyles.groupsAllBtnActive : ''}`}
                >
                  <span>{lang === 'ru' ? 'Все таблицы' : 'All groups'}</span>
                  {activeTagFilter.size === 0 && <span>✓</span>}
                </button>
                <div className={appStyles.groupsDivider} />
                {scopedTags.length === 0 && (
                  <div className={appStyles.layoutEmpty}>{lang === 'ru' ? 'Нет тегов' : 'No tags'}</div>
                )}
                {scopedTags.map(({ tag, count }) => (
                  <button
                    key={tag}
                    onClick={() => toggleActiveTag(tag)}
                    className={`${appStyles.groupsTagBtn} ${activeTagFilter.has(tag) ? appStyles.groupsTagBtnActive : ''}`}
                  >
                    <div className={appStyles.groupsTagLeft}>
                      <span className={`${appStyles.groupsCheckbox} ${activeTagFilter.has(tag) ? appStyles.groupsCheckboxChecked : ''}`}>
                        {activeTagFilter.has(tag) && '✓'}
                      </span>
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
                      className={`${appStyles.layoutMenuBtn} ${l.locked ? appStyles.lockToggleActive : ''}`}
                      onClick={e => { e.stopPropagation(); toggleLayoutLock(l.id) }}
                      title={l.locked
                        ? (lang === 'ru' ? 'Разблокировать лэйаут' : 'Unlock layout')
                        : (lang === 'ru' ? 'Заблокировать лэйаут' : 'Lock layout')}
                    >{l.locked ? '🔒' : '🔓'}</button>
                    <button
                      className={appStyles.layoutMenuBtn}
                      onClick={e => { e.stopPropagation(); setLayoutsOpen(false); setLayoutSettingsId(l.id) }}
                      title={lang === 'ru' ? 'Настройки слоя' : 'Layout settings'}
                    >⋯</button>
                  </div>
                ))}
                <div className={appStyles.groupsDivider} />
                <button
                  onClick={() => createLayout([])}
                  className={appStyles.createLayoutRowBtn}
                >
                  <span>＋</span>
                  <span>{lang === 'ru' ? 'Создать слой' : 'Create layout'}</span>
                </button>
              </div>
            )}
          </div>

          {/* Lock — only while a layout is active; blocks dragging on this layout's canvas only */}
          {activeLayout && (
            <div className={appStyles.toolPill}>
              <button
                onClick={() => toggleLayoutLock(activeLayout.id)}
                className={`${appStyles.toolBtn} ${activeLayout.locked ? appStyles.toolBtnActive : ''}`}
                title={activeLayout.locked
                  ? (lang === 'ru' ? 'Разблокировать лэйаут (разрешить перетаскивание)' : 'Unlock layout (allow dragging)')
                  : (lang === 'ru' ? 'Заблокировать лэйаут (запретить перетаскивание)' : 'Lock layout (prevent dragging)')}
              >
                <span className={appStyles.toolBtnIcon}>{activeLayout.locked ? '🔒' : '🔓'}</span>
                <span className={appStyles.toolBtnLabel}>{lang === 'ru' ? 'Блокировка' : 'Lock'}</span>
              </button>
            </div>
          )}

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
              <span style={{ fontSize: 13, fontFamily: 'monospace', fontWeight: 600 }}>{'{}'}</span>
              <span className={appStyles.toolBtnLabel}>JSON</span>
            </button>
          </div>
        </div>

        <div className={appStyles.topbarRight}>
          <button
            onClick={async () => {
              const filename = await promptFilename('json', 'schema')
              if (!filename) return
              exportJSON(serializeSchema(schema), masterPositionsRef.current, filename)
              dialog.alert(lang === 'ru' ? 'Экспорт JSON' : 'JSON Export', lang === 'ru' ? 'Файл схемы успешно скачан.' : 'The schema file has been successfully downloaded.')
            }}
            className={appStyles.exportBtn}
          >
            ↓ JSON
          </button>
          <button
            onClick={async () => {
              const filename = await promptFilename('sql', 'schema')
              if (!filename) return
              downloadSQL(schema, filename)
              dialog.alert(lang === 'ru' ? 'Экспорт SQL' : 'SQL Export', lang === 'ru' ? 'SQL DDL файл успешно скачан.' : 'The SQL DDL file has been successfully downloaded.')
            }}
            className={appStyles.exportBtn}
          >
            ↓ SQL
          </button>
          <button
            onClick={async () => {
              const filename = await promptFilename('drawio', 'schema')
              if (!filename) return
              handleExportDrawio(filename)
              dialog.alert(lang === 'ru' ? 'Экспорт draw.io' : 'draw.io Export', lang === 'ru' ? 'Файл .drawio со всеми лэйаутами (вкладками) успешно скачан.' : 'The .drawio file with all layouts as tabs has been downloaded.')
            }}
            className={appStyles.exportBtn}
          >
            ↓ drawio
          </button>
          <div className={appStyles.divider} />
          <ThemeSwitch theme={theme} onToggle={onThemeToggle} />
          <div className={appStyles.divider} />
          <button
            onClick={handleSave}
            className={appStyles.saveBtn}
            style={{ '--save-bg': saveFlash ? '#16a34a' : '#6366f1' } as React.CSSProperties}
          >
            {t.saveBtn}
          </button>
          <button onClick={handleExit} className={appStyles.exitBtn}>{t.exitBtn}</button>
        </div>
      </div>

      {/* Content */}
      <div className={appStyles.content}>
          <div className={appStyles.schemaView}>
            {splitView ? (
              <>
                <div className={appStyles.splitEditorPane} style={{ width: editorWidth }}>
                  <SchemaEditor schema={schema} masterPositions={masterPositionsRef.current} onSchemaChange={handleSchemaFromEditor} onValidityChange={setSchemaValid} width={editorWidth} />
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
              {/* Top-left selection/layout actions row: Create-layout or Add-table,
                  plus Hide/Show/Delete-from-layout when applicable. All the same
                  row so they don't stack into separate absolute-positioned FABs. */}
              <div className={appStyles.topLeftFabRow}>
                {/* Create-layout button — appears when a table (or group) is selected */}
                {highlightCtxValue.highlighted.size > 0 && !activeLayout && (
                  <button className={`${appStyles.createLayoutFab} ${appStyles.fabInWrap}`} onClick={createLayoutFromSelection}>
                    <span className={appStyles.createLayoutFabIcon}>▦</span>
                    {lang === 'ru' ? 'Создать слой' : 'Create layout'}
                    <span className={appStyles.createLayoutFabCount}>{highlightCtxValue.highlighted.size}</span>
                  </button>
                )}

                {/* Add-table button — appears whenever a layout is active */}
                {activeLayout && (
                  <button className={`${appStyles.createLayoutFab} ${appStyles.fabInWrap}`} onClick={() => setAddTablesOpen(true)}>
                    <span className={appStyles.createLayoutFabIcon}>＋</span>
                    {lang === 'ru' ? 'Добавить таблицу' : 'Add table'}
                  </button>
                )}

                {/* Hide — removes the current selection (and its edges) from this view only */}
                {highlightCtxValue.highlighted.size > 0 && (
                  <button className={`${appStyles.actionFab} ${appStyles.fabInWrap}`} onClick={hideSelected}>
                    <span className={appStyles.createLayoutFabIcon}>⊘</span>
                    {lang === 'ru' ? 'Скрыть' : 'Hide'}
                    <span className={appStyles.createLayoutFabCount}>{highlightCtxValue.highlighted.size}</span>
                  </button>
                )}

                {/* Show tables — only present while this view has hidden tables */}
                {currentHidden.size > 0 && (
                  <button className={`${appStyles.actionFab} ${appStyles.fabInWrap}`} onClick={showHiddenTables}>
                    <span className={appStyles.createLayoutFabIcon}>👁</span>
                    {lang === 'ru' ? 'Показать таблицы' : 'Show tables'}
                    <span className={appStyles.createLayoutFabCount}>{currentHidden.size}</span>
                  </button>
                )}

                {/* Delete — removes the selection from THIS layout only, never from the schema */}
                {activeLayout && highlightCtxValue.highlighted.size > 0 && (
                  <button
                    className={`${appStyles.actionFab} ${appStyles.actionFabDanger} ${appStyles.fabInWrap}`}
                    onClick={deleteSelectedFromLayout}
                    title={lang === 'ru' ? 'Удалить выбранные таблицы из этого лэйаута (в схеме останутся)' : 'Remove the selected tables from this layout (they stay in the schema)'}
                  >
                    <span className={appStyles.createLayoutFabIcon}>🗑</span>
                    {lang === 'ru' ? 'Удалить' : 'Delete'}
                    <span className={appStyles.createLayoutFabCount}>{highlightCtxValue.highlighted.size}</span>
                  </button>
                )}
              </div>

              {/* Add-to-layout — quick-add the selection to any OTHER existing layout */}
              {highlightCtxValue.highlighted.size > 0 && (schema.layouts ?? []).some(l => l.id !== activeLayoutId) && (
                <div className={appStyles.addToLayoutWrap}>
                  <button
                    className={`${appStyles.createLayoutFab} ${appStyles.fabInWrap}`}
                    onClick={() => setAddToLayoutOpen(o => !o)}
                  >
                    <span className={appStyles.createLayoutFabIcon}>⤵</span>
                    {lang === 'ru' ? 'Добавить в слой' : 'Add to layout'}
                    <span className={appStyles.createLayoutFabCount}>{highlightCtxValue.highlighted.size}</span>
                  </button>
                  {addToLayoutOpen && (
                    <div className={appStyles.addToLayoutMenu}>
                      {(schema.layouts ?? []).filter(l => l.id !== activeLayoutId).map(l => (
                        <button
                          key={l.id}
                          className={appStyles.addToLayoutItem}
                          onClick={() => {
                            addTablesToLayout([...highlightCtxValue.highlighted], l.id)
                            setAddToLayoutOpen(false)
                            setSelectedTables(new Set()); setHighlightTable(null)
                          }}
                        >
                          <span>{l.name}</span>
                          <span className={appStyles.addToLayoutItemCount}>{l.tables.length}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* Toast — top-right of the canvas, below the topbar */}
              {toast && <div className={appStyles.toast}>{toast}</div>}

              <ThemeCtx.Provider value={theme}>
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
                      onNodeClick={handleNodeClick}
                      onPaneClick={clearHighlight}
                      nodeTypes={NODE_TYPES}
                      edgeTypes={EDGE_TYPES}
                      fitView
                      fitViewOptions={{ padding: 0.2 }}
                      minZoom={0.05}
                      nodesDraggable={!activeLayout?.locked}
                      selectionMode={SelectionMode.Partial}
                      panOnDrag={[2]}
                      selectionOnDrag
                      selectNodesOnDrag={false}
                      multiSelectionKeyCode="Shift"
                      panOnScroll={true}
                      onInit={instance => { rfInstanceRef.current = instance }}
                    >
                      <NodesInitializedFitView rfRef={rfInstanceRef} />
                      <Background color={theme === 'dark' ? '#1a1d27' : '#dde0e6'} gap={20} />
                      <Controls
                        showInteractive={false}
                        className={appStyles.reactFlowControls}
                      />
                      <MiniMap
                        style={{ background: 'var(--bg-panel)', borderRadius: 16, border: '1px solid rgba(var(--overlay-rgb),0.08)', overflow: 'hidden' }}
                        nodeColor={n => tagColor((n.data as { table?: { tags?: string[] } }).table?.tags)}
                        maskColor="rgba(0,0,0,0.6)"
                      />
                    </ReactFlow>
                  </MultiSelectCtx.Provider>
                 </EdgeHoverCtx.Provider>
                </HighlightCtx.Provider>
              </ViewModeCtx.Provider>
              </ThemeCtx.Provider>

              {/* Non-blocking notice while the schema editor has errors — the
                  invalid draft never reaches `schema` (see SchemaEditor's
                  commit()), so the canvas can't go out of sync with it; no
                  need to block interaction with the canvas underneath. */}
              {splitView && !schemaValid && (
                <div className={appStyles.freezeBanner}>
                  ⚠ {lang === 'ru' ? 'Исправьте ошибки схемы в редакторе' : 'Fix schema errors in the editor'}
                </div>
              )}

              {/* Dragging is disabled (nodesDraggable above) while the active
                  layout is locked — tables can still be selected/edited. */}
              {activeLayout?.locked && (
                <div className={appStyles.lockedBanner}>
                  🔒 {lang === 'ru' ? 'Канвас заблокирован' : 'Canvas locked'}
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

      {addTablesOpen && activeLayout && (
        <AddTablesModal
          schema={schema}
          excludeNames={new Set(activeLayout.tables)}
          lang={lang}
          onConfirm={addTablesToLayout}
          onClose={() => setAddTablesOpen(false)}
        />
      )}
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

function MiniBadge({ label, color }: { label: string; color: string }) {
  const isFK = label === 'FK'
  const isUQ = label === 'UQ'
  const isNull = label === '?'
  const bg = isFK ? '#f59e0b33' : isUQ ? '#06b6d433' : isNull ? '#6b728033' : `${color}33`
  const col = isFK ? '#f59e0b' : isUQ ? '#06b6d4' : isNull ? '#6b7280' : color
  return (
    <span className={appStyles.miniBadge} style={{ '--mb-bg': bg, '--mb-color': col } as React.CSSProperties}>
      {label}
    </span>
  )
}

function AddTableCard({ table, selected, onClick }: {
  table: Table
  selected: boolean
  onClick: (e: React.MouseEvent) => void
}) {
  const accent = tagColor(table.tags)
  const cols = [
    ...table.columns.filter(c => c.primaryKey),
    ...table.columns.filter(c => c.foreignKey && !c.primaryKey),
    ...table.columns.filter(c => !c.primaryKey && !c.foreignKey),
  ]
  return (
    <div
      className={`${appStyles.addTableCard} ${selected ? appStyles.addTableCardSelected : ''}`}
      style={{ '--accent': accent } as React.CSSProperties}
      onClick={onClick}
    >
      {selected && <span className={appStyles.addTableCardCheck}>✓</span>}
      <div className={appStyles.addTableCardHeader}>
        <span className={appStyles.addTableCardName}>{table.name}</span>
        <span className={appStyles.addTableCardCount}>{table.columns.length} cols</span>
      </div>
      {table.tags && table.tags.length > 0 && (
        <div className={appStyles.addTableCardTags}>
          {table.tags.map(tag => <span key={tag} className={appStyles.addTableCardTag}>#{tag}</span>)}
        </div>
      )}
      <div className={appStyles.addTableCardCols}>
        {cols.map(col => (
          <div key={col.name} className={appStyles.addTableCardColRow}>
            <span className={appStyles.addTableCardColName}>{col.name}</span>
            <span className={appStyles.addTableCardColType}>{col.type}</span>
            <div className={appStyles.addTableCardBadges}>
              {col.primaryKey && <MiniBadge label="PK" color={accent} />}
              {col.foreignKey && <MiniBadge label="FK" color="#f59e0b" />}
              {col.unique && !col.primaryKey && <MiniBadge label="UQ" color="#06b6d4" />}
              {col.nullable && <MiniBadge label="?" color="#6b7280" />}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function AddTablesModal({ schema, excludeNames, lang, onConfirm, onClose }: {
  schema: Schema
  excludeNames: Set<string>
  lang: Lang
  onConfirm: (names: string[]) => void
  onClose: () => void
}) {
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())

  const candidates = useMemo(
    () => schema.tables.filter(t => !excludeNames.has(t.name)),
    [schema.tables, excludeNames]
  )
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return q ? candidates.filter(t => t.name.toLowerCase().includes(q)) : candidates
  }, [candidates, search])

  const toggle = (name: string, shiftKey: boolean) => {
    setSelected(prev => {
      if (!shiftKey) return prev.has(name) && prev.size === 1 ? new Set() : new Set([name])
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })
  }

  return (
    <div className={appStyles.layoutModalOverlay} onClick={onClose}>
      <div className={appStyles.addTablesModal} onClick={e => e.stopPropagation()}>
        <div className={appStyles.layoutModalHeader}>
          <span className={appStyles.layoutModalTitle}>{lang === 'ru' ? 'Добавить таблицы' : 'Add tables'}</span>
          <button className={appStyles.layoutModalClose} onClick={onClose}>×</button>
        </div>

        <input
          className={appStyles.addTablesSearch}
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder={lang === 'ru' ? 'Поиск по имени таблицы…' : 'Search tables…'}
          autoFocus
        />

        <div className={appStyles.addTablesGridWrap}>
          {filtered.length === 0 ? (
            <div className={appStyles.addTablesEmpty}>
              {candidates.length === 0
                ? (lang === 'ru' ? 'Все таблицы уже в этом слое' : 'All tables are already in this layout')
                : (lang === 'ru' ? 'Ничего не найдено' : 'No tables found')}
            </div>
          ) : (
            <div className={appStyles.addTablesGrid}>
              {filtered.map(t => (
                <AddTableCard
                  key={t.name}
                  table={t}
                  selected={selected.has(t.name)}
                  onClick={e => toggle(t.name, e.shiftKey)}
                />
              ))}
            </div>
          )}
        </div>

        <div className={appStyles.layoutModalFooter}>
          <span className={appStyles.addTablesSelectedCount}>
            {selected.size > 0 ? (lang === 'ru' ? `Выбрано: ${selected.size}` : `${selected.size} selected`) : ''}
          </span>
          <div className={appStyles.layoutModalFooterRight}>
            <button className={appStyles.layoutModalCancel} onClick={onClose}>{lang === 'ru' ? 'Отмена' : 'Cancel'}</button>
            <button
              className={appStyles.layoutModalSave}
              disabled={selected.size === 0}
              onClick={() => onConfirm([...selected])}
            >
              {lang === 'ru' ? `Добавить (${selected.size})` : `Add (${selected.size})`}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
