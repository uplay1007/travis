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
  useNodes,
  useReactFlow,
  useUpdateNodeInternals,
  type Node,
  type Edge,
  type OnSelectionChangeParams,
  type ReactFlowInstance,
  type NodeChange,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'

import type { Schema, Table, Column, Layout, TableType } from './types/schema'
import { computeLayout } from './utils/layout'
import { tableAccent } from './utils/colors'
import {
  saveCurrentSession, loadCurrentSession, clearCurrentSession, saveDB,
} from './utils/storage'
import { TableNode, type TableNodeData } from './components/canvas/TableNode'
import { HighlightCtx, type HighlightCtxValue, type TableSelectionGesture } from './contexts/highlight'
import { EdgeHoverCtx, type EdgeEndpoint } from './contexts/edgeHover'
import { ViewModeCtx, type ViewMode, type ViewModeCtxValue } from './contexts/viewMode'
import { ThemeCtx } from './contexts/theme'
import { OrthoEdge, type OrthoEdgeData } from './components/canvas/OrthoEdge'
import {
  routeOrtho, spreadOverlappingSegments,
  type Side, type Pt, type Rect as OrthoRect,
} from './utils/orthoRoute'
import { computeELKLayout } from './services/layoutService'
import { resolveOverlaps, type Rect } from './utils/separateNodes'
import { TableEditor } from './components/editor/TableEditor'
import { Sidebar } from './components/shell/Sidebar'
import { SchemaEditor, type DSLDraftStatus } from './components/editor/SchemaEditor'
import { UploadZone, type OpenResult } from './components/shell/UploadZone'
import { downloadTextFile, pickSaveFile, writeToHandle } from './utils/fileAccess'
import { exportSQL } from './utils/parsers/sql'
import { schemaToStructured } from './utils/structuredJSON'
import { exportDrawio, type DrawioPage } from './utils/drawioExport'
import { T, type Lang } from './i18n'
import { TABLE_TYPES } from './utils/tableTypes'
import { DialogProvider, useDialog } from './contexts/DialogContext'
import { Logo } from './components/ui/Logo'
import { RepositoryLink } from './components/ui/RepositoryLink'
import { ThemeSwitch } from './components/ui/ThemeSwitch'
import appStyles from './App.module.css'

const NODE_TYPES = { table: TableNode }
const EDGE_TYPES = { fk: OrthoEdge }

interface NodeSize { width: number; height: number }

// React Flow v12 keeps each node's measured size in its own store and never
// reports it back through onNodesChange, so the `nodes` state App owns has no
// `measured` at all — everything reading it silently fell back to a uniform
// 280x120 (ELK's height input, overlap resolution, edge obstacles). This
// child sits inside <ReactFlow>, where the store is reachable, and mirrors
// the real sizes back out.
function NodeMeasureSync({ onMeasured }: { onMeasured: (sizes: Record<string, NodeSize>) => void }) {
  const nodes = useNodes()
  useEffect(() => {
    const sizes: Record<string, NodeSize> = {}
    for (const n of nodes) {
      const m = n.measured
      if (m?.width && m?.height) sizes[n.id] = { width: m.width, height: m.height }
    }
    onMeasured(sizes)
  }, [nodes, onMeasured])
  return null
}

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
  // A single-column primary key is unique. In a junction table, each
  // member of a composite primary key can repeat independently.
  if (col.unique) return '1:1'
  if (col.primaryKey) {
    return table.columns.some(column => column !== col && column.primaryKey) ? '1:N' : '1:1'
  }
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
const EMPTY_TYPE_SET: ReadonlySet<TableType> = new Set()

const VIEW_MODES: { value: ViewMode; en: string; ru: string }[] = [
  { value: 'full',      en: 'Full',      ru: 'Полный' },
  { value: 'compact',   en: 'Compact',   ru: 'Компактный' },
  { value: 'collapsed', en: 'Collapsed', ru: 'Свёрнутый' },
]

// Close a toolbar dropdown when the next mousedown lands outside its pill.
function useCloseOnOutsideClick(
  open: boolean,
  ref: React.RefObject<HTMLElement | null>,
  close: () => void,
) {
  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as globalThis.Node)) close()
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open, ref, close])
}

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
          sourceColor: tableAccent(table),
          targetColor: tableAccent(targetTable),
          sourceColumn: col.name,
          targetColumn: col.foreignKey.column,
        } satisfies OrthoEdgeData,
      })
    }
  }
  return { nodes, edges }
}

type EditorState = null | 'new' | string

const DELETE_UNDO_MS = 5000

interface PendingDeletion {
  id: string
  layoutId: string | null
  names: ReadonlySet<string>
  expiresAt: number
  expired?: boolean
}

function pendingTableNames(deletions: PendingDeletion[], layoutId: string | null): Set<string> {
  return new Set(deletions.flatMap(deletion =>
    deletion.layoutId === null || deletion.layoutId === layoutId ? [...deletion.names] : []
  ))
}

const EXPORT_FORMATS = {
  json: { label: 'JSON', mimeType: 'application/json' },
  sql: { label: 'SQL', mimeType: 'text/plain' },
  drawio: { label: 'draw.io', mimeType: 'application/xml' },
}

type ExportFormat = keyof typeof EXPORT_FORMATS

function withExt(name: string, ext: string): string {
  const trimmed = name.trim()
  if (!trimmed) return `schema.${ext}`
  return trimmed.toLowerCase().endsWith(`.${ext}`) ? trimmed : `${trimmed}.${ext}`
}

function downloadJSON(schema: Schema, masterPositions: Record<string, { x: number; y: number }>) {
  const content = JSON.stringify(schemaToStructured(schema, masterPositions), null, 2)
  downloadTextFile(content, EXPORT_FORMATS.json.mimeType, 'schema.json')
}

export default function App() {
  const [lang, setLang] = useState<Lang>('en')
  const [projectKey, setProjectKey] = useState(0)
  const [theme, setTheme] = useState<'dark' | 'light'>(
    () => (localStorage.getItem('travis_theme') === 'light' ? 'light' : 'dark')
  )
  useEffect(() => {
    document.documentElement.dataset.theme = theme
    localStorage.setItem('travis_theme', theme)
  }, [theme])
  const toggleTheme = useCallback(() => setTheme(t => (t === 'dark' ? 'light' : 'dark')), [])
  const closeProject = useCallback(() => {
    clearCurrentSession()
    setProjectKey(key => key + 1)
  }, [])

  return (
    <DialogProvider lang={lang}>
      <AppContent key={projectKey} lang={lang} setLang={setLang} theme={theme} onThemeToggle={toggleTheme} onProjectExit={closeProject} />
    </DialogProvider>
  )
}

function AppContent({ lang, setLang, theme, onThemeToggle, onProjectExit }: {
  lang: Lang
  setLang: React.Dispatch<React.SetStateAction<Lang>>
  theme: 'dark' | 'light'
  onThemeToggle: () => void
  onProjectExit: () => void
}) {
  const session = useMemo(() => loadCurrentSession(), [])
  const dialog = useDialog()

  const [schema, setSchema] = useState<Schema | null>(session?.schema ?? null)
  const schemaRef = useRef(schema)
  schemaRef.current = schema
  const [fileHandle, setFileHandle] = useState<FileSystemFileHandle | null>(null)
  const [exporting, setExporting] = useState(false)
  const currentSave = useRef(session?.namedSave)
  const hasExited = useRef(false)

  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([])
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([])
  const nodesRef = useRef<Node[]>([])
  useEffect(() => { nodesRef.current = nodes }, [nodes])
  const rfInstanceRef = useRef<ReactFlowInstance<any, any> | null>(null)
  const pendingNewTableFit = useRef<{ tableId: string; neighborId: string } | null>(null)

  // Real per-node sizes, mirrored out of React Flow's store by NodeMeasureSync.
  // Kept in a ref for callbacks; the version counter is what memos depend on,
  // and it only ticks when a size actually changed (otherwise mirroring would
  // feed its own re-render loop).
  const sizesRef = useRef<Record<string, NodeSize>>({})
  const [sizesVersion, setSizesVersion] = useState(0)
  const handleMeasured = useCallback((sizes: Record<string, NodeSize>) => {
    const pendingFit = pendingNewTableFit.current
    if (pendingFit && sizes[pendingFit.tableId]) {
      pendingNewTableFit.current = null
      void rfInstanceRef.current?.fitView({
        nodes: [{ id: pendingFit.tableId }, { id: pendingFit.neighborId }],
        padding: 0.2,
        duration: 300,
      })
    }
    const prev = sizesRef.current
    const keys = Object.keys(sizes)
    const unchanged = keys.length === Object.keys(prev).length &&
      keys.every(k => prev[k]?.width === sizes[k].width && prev[k]?.height === sizes[k].height)
    if (unchanged) return
    sizesRef.current = sizes
    setSizesVersion(v => v + 1)
  }, [])
  const sizeOf = useCallback((id: string): NodeSize => sizesRef.current[id] ?? { width: 280, height: 120 }, [])

  const masterPositionsRef = useRef<Record<string, { x: number; y: number }>>(session?.positions ?? {})

  const [editorState, setEditorState] = useState<EditorState>(null)
  const [saveFlash, setSaveFlash] = useState(false)

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
  // table-type (reference/master/fact/…) filter — like the group filter it's
  // per view, but it's a pure show/hide overlay (see typeHidden): checking a
  // type must not re-arrange the canvas underneath the way a tag change does.
  const [typeFilters, setTypeFilters] = useState<Record<string, Set<TableType>>>({})
  const [typesOpen, setTypesOpen] = useState(false)
  const typesBtnRef = useRef<HTMLDivElement>(null)
  const [viewModeOpen, setViewModeOpen] = useState(false)
  const viewModeBtnRef = useRef<HTMLDivElement>(null)
  const [groupsOpen, setGroupsOpen] = useState(false)
  const [activeLayoutId, setActiveLayoutId] = useState<string | null>(session?.activeLayoutId ?? null)
  // mirror of activeLayoutId for use inside save callbacks without dep churn
  const activeLayoutIdRef = useRef(activeLayoutId)
  useEffect(() => { activeLayoutIdRef.current = activeLayoutId }, [activeLayoutId])
  const persistSession = useCallback((schema: Schema) => {
    if (hasExited.current) return
    saveCurrentSession({
      schema,
      positions: masterPositionsRef.current,
      activeLayoutId: activeLayoutIdRef.current,
      namedSave: currentSave.current,
    })
  }, [])
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
  useEffect(() => () => clearTimeout(toastTimer.current), [])
  const [pendingDeletions, setPendingDeletions] = useState<PendingDeletion[]>([])
  const pendingDeletionsRef = useRef(pendingDeletions)
  const updatePendingDeletions = useCallback((next: PendingDeletion[]) => {
    pendingDeletionsRef.current = next
    setPendingDeletions(next)
  }, [])
  const layoutsBtnRef = useRef<HTMLDivElement>(null)
  // Keep layout position snapshots immutable so the canvas and DSL can share them.
  const layoutPosRef = useRef<Record<string, Layout['positions']>>({})
  const layoutPositions = layoutPosRef.current
  const setLayoutPositions = useCallback((id: string, positions: Layout['positions']) => {
    layoutPosRef.current = { ...layoutPosRef.current, [id]: positions }
  }, [])
  const serializeSchema = useCallback((s: Schema, positions = layoutPosRef.current): Schema => {
    if (!s.layouts?.length) return s
    return { ...s, layouts: s.layouts.map(l => ({ ...l, positions: positions[l.id] ?? l.positions })) }
  }, [])
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
  const [deletionVersion, setDeletionVersion] = useState(0)
  const dslDraftRef = useRef<string | null>(null)
  const [dslStatus, setDslStatus] = useState<DSLDraftStatus>('idle')
  // Update immediately for canvas events; async layout work also checks identity
  // before applying a result started before the current DSL edit.
  const dslStatusRef = useRef({ status: dslStatus })
  const canvasReadOnly = dslStatus !== 'idle'
  const handleDSLStatus = useCallback((status: DSLDraftStatus) => {
    if (dslStatusRef.current.status === status) return
    dslStatusRef.current = { status }
    setDslStatus(status)
  }, [])
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
  const activeTypeFilter = typeFilters[viewKey] ?? EMPTY_TYPE_SET
  const pendingInView = useMemo(
    () => pendingTableNames(pendingDeletions, activeLayoutId),
    [pendingDeletions, activeLayoutId],
  )
  const pendingGlobal = useMemo(() => pendingTableNames(pendingDeletions, null), [pendingDeletions])

  // Tables filtered out by the type filter. Kept separate from the tag filter
  // (which re-frames the base view) and folded in with the manual Hide set
  // instead, so ticking a type only shows/hides — it never moves a table.
  const typeHidden = useMemo(() => {
    if (!schema || activeTypeFilter.size === 0) return EMPTY_TAG_SET
    return new Set(schema.tables.filter(t => !t.type || !activeTypeFilter.has(t.type)).map(t => t.name))
  }, [schema, activeTypeFilter])

  const hiddenNames = useMemo(
    () => new Set([...currentHidden, ...typeHidden, ...pendingInView]),
    [currentHidden, typeHidden, pendingInView],
  )

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
      const pos = layoutPositions[activeLayout.id] ?? {}
      return nodes.map(n => ({
        ...n,
        hidden: !scopedVisibleNames?.has(n.id) || hiddenNames.has(n.id),
        position: pos[n.id] ?? n.position,
      }))
    }
    if (!scopedVisibleNames) {
      return nodes.map(n => ({
        ...n,
        hidden: hiddenNames.has(n.id),
        position: masterPositionsRef.current[n.id] ?? n.position
      }))
    }
    return nodes.map(n => ({ ...n, hidden: !scopedVisibleNames.has(n.id) || hiddenNames.has(n.id) }))
  }, [nodes, scopedVisibleNames, hiddenNames, activeLayout, layoutPositions])

  const displayEdges = useMemo(() => {
    let visibleEdges = edges
    if (scopedVisibleNames) {
      visibleEdges = visibleEdges.filter(e => scopedVisibleNames.has(e.source) && scopedVisibleNames.has(e.target))
    }
    if (hiddenNames.size > 0) {
      visibleEdges = visibleEdges.filter(e => !hiddenNames.has(e.source) && !hiddenNames.has(e.target))
    }

    // re-pick each edge's connection side and exact anchor point against the
    // tables' current positions (drag, layout switch, Organize, ...) — see
    // pickBestSides/fanOutSideAnchors
    const rects = new Map<string, TableRect>()
    for (const n of displayNodes) {
      const s = sizeOf(n.id)
      rects.set(n.id, { x: n.position.x, y: n.position.y, width: s.width, height: s.height })
    }
    const anchors = fanOutSideAnchors(
      visibleEdges.map(e => ({ id: e.id, sourceId: e.source, targetId: e.target })),
      rects,
    )

    // Route every edge here rather than inside each OrthoEdge: two different
    // edges' paths can end up running along the exact same line mid-route
    // (fanOutSideAnchors only spreads where they ATTACH), and spotting that
    // needs all the routes at once — see spreadOverlappingSegments.
    const obstacles: { id: string; rect: OrthoRect }[] = []
    for (const n of displayNodes) {
      if (n.hidden) continue
      const r = rects.get(n.id)
      if (r) obstacles.push({ id: n.id, rect: { x: r.x, y: r.y, width: r.width, height: r.height } })
    }
    const routes = new Map<string, Pt[]>()
    for (const e of visibleEdges) {
      const a = anchors.get(e.id)
      if (!a) continue
      const pts = routeOrtho(
        a.sourcePoint, a.sourceSide, a.targetPoint, a.targetSide,
        obstacles.filter(o => o.id !== e.source && o.id !== e.target).map(o => o.rect),
      )
      if (pts) routes.set(e.id, pts)
    }
    const spread = spreadOverlappingSegments(routes)

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
          points: spread.get(e.id),
        } satisfies OrthoEdgeData,
      }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- sizesVersion stands in for sizesRef
  }, [edges, scopedVisibleNames, hiddenNames, displayNodes, sizeOf, sizesVersion])

  // Reflect React Flow's marquee and native single selection in the canvas UI.
  // Modifier clicks update the app's selection through handleTableClick.
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
    if (ids.length > 1) {
      setSelectedTables(new Set(ids))
      setHighlightTable(null)
    } else {
      setSelectedTables(new Set())
      setHighlightTable(ids[0] ?? null)
    }
  }, [])

  const handleNodeClick = useCallback((e: React.MouseEvent, node: Node) => {
    if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return
    setSelectedTables(new Set())
    setHighlightTable(node.id)
    // React Flow can keep the marquee group when clicking one of its members.
    setNodes(current => current.some(n => n.selected && n.id !== node.id)
      ? current.map(n => n.selected && n.id !== node.id ? { ...n, selected: false } : n)
      : current)
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

  // Table types actually present in the current view — same "no dead
  // controls" scoping as scopedTags above.
  const scopedTypes = useMemo(() => {
    if (!schema) return []
    const source = activeLayout
      ? schema.tables.filter(t => activeLayout.tables.includes(t.name))
      : schema.tables
    const counts = {} as Record<TableType, number>
    for (const t of source) {
      if (t.type) counts[t.type] = (counts[t.type] ?? 0) + 1
    }
    return TABLE_TYPES.filter(tt => counts[tt.value]).map(tt => ({ ...tt, count: counts[tt.value] }))
  }, [schema, activeLayout])

  const toggleActiveType = useCallback((type: TableType) => {
    setTypeFilters(prev => {
      const next = new Set(prev[viewKey] ?? [])
      if (next.has(type)) next.delete(type); else next.add(type)
      return { ...prev, [viewKey]: next }
    })
  }, [viewKey])

  const clearActiveTypeFilter = useCallback(() => {
    setTypeFilters(prev => {
      if (!prev[viewKey]?.size) return prev
      const next = { ...prev }
      delete next[viewKey]
      return next
    })
  }, [viewKey])

  useCloseOnOutsideClick(groupsOpen, groupsBtnRef, useCallback(() => setGroupsOpen(false), []))
  useCloseOnOutsideClick(layoutsOpen, layoutsBtnRef, useCallback(() => setLayoutsOpen(false), []))
  useCloseOnOutsideClick(typesOpen, typesBtnRef, useCallback(() => setTypesOpen(false), []))
  useCloseOnOutsideClick(viewModeOpen, viewModeBtnRef, useCallback(() => setViewModeOpen(false), []))

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
    const validation = dslStatusRef.current
    if (validation.status !== 'idle') return
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
        heights[n.id] = sizeOf(n.id).height
      })
    }

    computeELKLayout(schema, heights, visibleNames).then(({ positions }) => {
      if (validation !== dslStatusRef.current || schema !== schemaRef.current) return
      const pending = pendingTableNames(pendingDeletionsRef.current, null)
      setNodes(prev => prev.map(n =>
        positions[n.id] && !pending.has(n.id) ? { ...n, position: positions[n.id] } : n
      ))
      if (tagChanged) setTimeout(() => rfInstanceRef.current?.fitView({ padding: 0.2, duration: 400 }), 50)
    })
  }, [baseTagKey, baseTagFilter, schema, setNodes, viewMode, activeLayoutId])

  const clearHighlight = useCallback(() => {
    setHighlightTable(null)
    setSelectedTables(new Set())
  }, [])

  const stageDeletion = useCallback((names: ReadonlySet<string>, layoutId: string | null) => {
    const deletion = { id: crypto.randomUUID(), names, layoutId, expiresAt: Date.now() + DELETE_UNDO_MS }
    updatePendingDeletions([...pendingDeletionsRef.current, deletion])
    clearHighlight()
  }, [clearHighlight, updatePendingDeletions])

  const undoDeletion = useCallback((deletion: PendingDeletion) => {
    if (Date.now() >= deletion.expiresAt) return
    updatePendingDeletions(pendingDeletionsRef.current.filter(item => item.id !== deletion.id))
  }, [updatePendingDeletions])

  // Modifier gestures build a selection independently of React Flow's marquee.
  const handleTableClick = useCallback((name: string, gesture: TableSelectionGesture) => {
    if (!schema || dslStatusRef.current.status !== 'idle') return
    setNodes(current => current.some(n => n.selected)
      ? current.map(n => n.selected ? { ...n, selected: false } : n)
      : current)

    if (gesture === 'toggle') {
      setSelectedTables(prev => {
        const next = new Set(prev.size > 0 ? prev : highlightTable ? [highlightTable] : [])
        if (next.has(name)) next.delete(name)
        else next.add(name)
        return next
      })
      setHighlightTable(null)
      return
    }
    if (gesture === 'related') {
      setHighlightTable(null)
      setSelectedTables(fkNeighborhood(schema.tables, name))
      return
    }
    const visibleTables = schema.tables.filter(t =>
      (!scopedVisibleNames || scopedVisibleNames.has(t.name)) && !hiddenNames.has(t.name)
    )
    setHighlightTable(name)
    setSelectedTables(new Set([name, ...exclusiveNeighbors(visibleTables, name)]))
  }, [schema, scopedVisibleNames, hiddenNames, highlightTable, setNodes])

  const handleNodeContextMenu = useCallback((e: React.MouseEvent, node: Node) => {
    // macOS reports Control + left click as a context menu with button 0.
    if (e.ctrlKey && e.button === 0) {
      e.preventDefault()
      if (!(e.target instanceof Element && e.target.closest('button'))) {
        handleTableClick(node.id, 'toggle')
      }
      return
    }
    if (!e.shiftKey) return
    e.preventDefault()
    handleTableClick(node.id, 'related')
  }, [handleTableClick])

  const actionSelection = useMemo(() => {
    const selected = selectedTables.size > 0 ? selectedTables : new Set(highlightTable ? [highlightTable] : [])
    return new Set((schema?.tables ?? [])
      .map(t => t.name)
      .filter(name => selected.has(name) && (!scopedVisibleNames || scopedVisibleNames.has(name)) && !hiddenNames.has(name)))
  }, [schema, selectedTables, highlightTable, scopedVisibleNames, hiddenNames])

  const highlightCtxValue = useMemo((): HighlightCtxValue => {
    const focus = highlightTable && actionSelection.has(highlightTable) ? highlightTable : null
    const groupMode = selectedTables.size > 0
    return {
      active: actionSelection.size > 0,
      highlighted: !groupMode && focus && schema ? fkNeighborhood(schema.tables, focus) : actionSelection,
      selected: actionSelection,
      focusTable: focus,
      groupMode,
      onHighlight: handleTableClick,
    }
  }, [highlightTable, selectedTables, actionSelection, schema, handleTableClick])

  const [edgeHover, setEdgeHover] = useState<{ source: EdgeEndpoint; target: EdgeEndpoint } | null>(null)
  const edgeHoverCtxValue = useMemo(() => ({
    source: edgeHover?.source ?? null,
    target: edgeHover?.target ?? null,
    setHover: setEdgeHover,
  }), [edgeHover])

  const handleLayout = useCallback(async () => {
    const validation = dslStatusRef.current
    if (!schema || layouting || validation.status !== 'idle') return
    setLayouting(true)
    try {
      const heights: Record<string, number> = {}
      if (viewMode !== 'collapsed') {
        nodesRef.current.forEach(n => {
          heights[n.id] = sizeOf(n.id).height
        })
      }
      const pending = pendingTableNames(pendingDeletionsRef.current, activeLayoutId)
      const viewTables = activeLayout?.tables ?? schema.tables.map(table => table.name)
      const filter = activeLayout || pending.size > 0
        ? new Set(viewTables.filter(name => !pending.has(name)))
        : undefined
      const { positions } = await computeELKLayout(schema, heights, filter)
      if (validation !== dslStatusRef.current || schema !== schemaRef.current) return
      for (const name of pendingTableNames(pendingDeletionsRef.current, activeLayoutId)) {
        delete positions[name]
      }
      if (activeLayout) {
        setLayoutPositions(activeLayout.id, { ...layoutPosRef.current[activeLayout.id], ...positions })
      } else if (baseTagFilter.size === 0) {
        masterPositionsRef.current = { ...masterPositionsRef.current, ...positions }
      }
      setNodes(prev => prev.map(n => ({ ...n, position: positions[n.id] ?? n.position })))
      // save immediately — Organize is a deliberate "commit this result" action,
      // so it can't be left to the 1s drag-debounced autosave: a reload before
      // that timer fires would silently revert to the pre-Organize positions
      persistSession(serializeSchema(schema))
      // re-frame the camera on the freshly arranged tables
      setTimeout(() => rfInstanceRef.current?.fitView({ padding: 0.2, duration: 400 }), 60)
    } catch (err) {
      console.error('ELK layout failed:', err)
    } finally {
      setLayouting(false)
    }
  }, [schema, layouting, setNodes, baseTagFilter, viewMode, activeLayout, activeLayoutId, persistSession, setLayoutPositions, serializeSchema])

  useEffect(() => {
    if (!pendingELK || layouting || canvasReadOnly || nodes.length === 0) return
    const visibleNodes = baseTagFilter.size > 0 && schema
      ? nodes.filter(n => schema.tables.find(t => t.name === n.id)?.tags?.some(tag => baseTagFilter.has(tag)))
      : nodes
    if (visibleNodes.length === 0) return
    if (visibleNodes.some(n => !sizesRef.current[n.id])) return
    setPendingELK(false)
    handleLayout()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- sizesVersion stands in for sizesRef
  }, [pendingELK, nodes, layouting, handleLayout, baseTagFilter, schema, sizesVersion, canvasReadOnly])

  // persist a dragged position to the active view: layout ref, else master
  // (tag-filter view is ephemeral — no persistence)
  const persistPos = useCallback((id: string, pos: { x: number; y: number }) => {
    if (activeLayoutId) {
      const positions = layoutPosRef.current[activeLayoutId]
      const previous = positions?.[id]
      if (previous?.x === pos.x && previous.y === pos.y) return
      setLayoutPositions(activeLayoutId, { ...positions, [id]: pos })
    } else if (baseTagFilter.size === 0) {
      // fresh object (not an in-place mutation) so consumers that only
      // re-render on reference change (e.g. the JSON editor's live preview
      // of master positions) actually pick up the drag
      masterPositionsRef.current = { ...masterPositionsRef.current, [id]: pos }
    }
  }, [activeLayoutId, baseTagFilter, setLayoutPositions])

  const handleNodesChange = useCallback((changes: NodeChange[]) => {
    if (dslStatusRef.current.status !== 'idle') {
      const measurements = changes.filter(change => change.type === 'dimensions')
      if (measurements.length) onNodesChange(measurements)
      return
    }
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
    if (dslStatusRef.current.status !== 'idle') return
    if (!highlightCtxValue.groupMode || !actionSelection.has(node.id)) return
    groupDragOrigins.current = Object.fromEntries(
      nodes
        .filter(n => actionSelection.has(n.id))
        .map(n => [n.id, resolvedPosition(n)])
    )
  }, [highlightCtxValue.groupMode, actionSelection, nodes, resolvedPosition])

  const handleNodeDrag = useCallback((_e: MouseEvent | TouchEvent, node: Node) => {
    if (dslStatusRef.current.status !== 'idle') return
    const isGroupDrag = highlightCtxValue.groupMode && actionSelection.has(node.id)

    persistPos(node.id, { x: node.position.x, y: node.position.y })

    if (!isGroupDrag) return
    const origin = groupDragOrigins.current[node.id]
    if (!origin) return
    const dx = node.position.x - origin.x
    const dy = node.position.y - origin.y
    setNodes(prev => prev.map(n => {
      if (n.id === node.id) return n
      if (!actionSelection.has(n.id)) return n
      const o = groupDragOrigins.current[n.id]
      if (!o) return n
      const newPos = { x: o.x + dx, y: o.y + dy }
      persistPos(n.id, newPos)
      return { ...n, position: newPos }
    }))
  }, [highlightCtxValue.groupMode, actionSelection, setNodes, persistPos])

  // Push apart tables that ended up overlapping, from their current on-screen
  // positions and measured sizes. Nodes in `pinned` stay put.
  const separateOverlaps = useCallback((pinned: Set<string>) => {
    if (dslStatusRef.current.status !== 'idle') return
    const current = nodesRef.current
    if (current.length === 0) return

    // in a layout, only its visible tables take part in overlap resolution
    const visibleSet = activeLayout ? new Set(activeLayout.tables) : null

    const rects = new Map<string, Rect>()
    for (const n of current) {
      if (visibleSet && !visibleSet.has(n.id)) continue
      const s = sizeOf(n.id)
      const p = resolvedPosition(n)
      rects.set(n.id, { x: p.x, y: p.y, w: s.width, h: s.height })
    }

    const resolved = resolveOverlaps(rects, new Set([...pinned, ...pendingInView]))

    resolved.forEach((p, id) => persistPos(id, p))
    setNodes(prev => prev.map(n => {
      const p = resolved.get(n.id)
      if (!p || (p.x === n.position.x && p.y === n.position.y)) return n
      return { ...n, position: p }
    }))
  }, [setNodes, persistPos, activeLayout, resolvedPosition, pendingInView])

  const handleNodeDragStop = useCallback((_e: MouseEvent | TouchEvent, node: Node) => {
    // Pin the grabbed node and let the rest of the selected group adjust,
    // so overlaps inside the group get resolved too.
    separateOverlaps(new Set([node.id]))
  }, [separateOverlaps])

  // Switching detail level changes every card's height, so tables that sat
  // clear of each other in Collapsed can overlap in Full. Dragging used to be
  // the only thing that resolved overlaps — run a pass here too, once the
  // 0.28s fold/unfold animation has settled and the nodes are re-measured.
  // Nothing is pinned: no single table is "the one you grabbed" here.
  const separateOverlapsRef = useRef(separateOverlaps)
  useEffect(() => { separateOverlapsRef.current = separateOverlaps })
  const prevBulkKeyRef = useRef(bulkKey)
  useEffect(() => {
    // the guard only skips the initial mount; it's marked seen inside the
    // timeout, not before it, so StrictMode's double-invoke (mount, cleanup,
    // re-mount) doesn't cancel the only run and then skip the retry
    if (bulkKey === prevBulkKeyRef.current) return
    const t = setTimeout(() => {
      prevBulkKeyRef.current = bulkKey
      separateOverlapsRef.current(new Set())
    }, 600)
    return () => clearTimeout(t)
  }, [bulkKey])

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
    setLayoutPositions(id, positions)
    const layouts = [...(schema.layouts ?? []), { id, name, tables, positions, viewMode }]
    setSchema({ ...schema, layouts })
    setSelectedTables(new Set()); setHighlightTable(null)
    setLayoutsOpen(false)
    setActiveLayoutId(id)
    if (tables.length > 0) {
      setTimeout(() => rfInstanceRef.current?.fitView({ padding: 0.2, duration: 400 }), 60)
    }
  }, [schema, viewMode, setLayoutPositions])

  const createLayoutFromSelection = useCallback(() => {
    const tables = [...actionSelection]
    if (tables.length === 0) return
    createLayout(tables)
  }, [actionSelection, createLayout])

  // Add tables to a layout (the active one by default, or `targetLayoutId` for
  // a cross-layout add): tables already in the target are skipped; existing
  // ones keep their positions (pinned); genuinely new ones get a compact ELK
  // layout among themselves, offset to sit beside the existing cluster, then
  // nudged clear of any overlap.
  const addTablesToLayout = useCallback(async (names: string[], targetLayoutId?: string) => {
    const validation = dslStatusRef.current
    if (validation.status !== 'idle') return
    const target = targetLayoutId ? schema?.layouts?.find(l => l.id === targetLayoutId) : activeLayout
    if (!target || !schema) return
    const newNames = names.filter(n => !target.tables.includes(n))
    if (newNames.length === 0) return

    const heights: Record<string, number> = {}
    nodesRef.current.forEach(n => {
      heights[n.id] = sizeOf(n.id).height
    })

    const { positions: newPositions } = await computeELKLayout(schema, heights, new Set(newNames))
    if (validation !== dslStatusRef.current || schema !== schemaRef.current) return

    const existingPos = layoutPosRef.current[target.id] ?? {}
    let maxX = 0, minY = 0, any = false
    for (const name of target.tables) {
      const p = existingPos[name]
      if (!p) continue
      const w = sizeOf(name).width
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
      const s = sizeOf(name)
      rects.set(name, { x: p.x, y: p.y, w: s.width, h: s.height })
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
    setLayoutPositions(target.id, posMap)

    setSchema({
      ...schema,
      layouts: schema.layouts!.map(l => l.id === target.id ? { ...l, tables: [...l.tables, ...newNames] } : l),
    })
    showToast(addedToLayoutMsg(target.name, newNames, lang))
    if (target.id === activeLayout?.id) {
      setAddTablesOpen(false)
      setTimeout(() => rfInstanceRef.current?.fitView({ padding: 0.2, duration: 400 }), 60)
    }
  }, [activeLayout, schema, showToast, lang, setLayoutPositions])

  const renameLayout = useCallback((id: string, name: string) => {
    if (!schema || !name.trim()) return
    setSchema({ ...schema, layouts: (schema.layouts ?? []).map(l => l.id === id ? { ...l, name: name.trim() } : l) })
  }, [schema])

  const deleteLayout = useCallback((id: string) => {
    if (!schema) return
    const positions = { ...layoutPosRef.current }
    delete positions[id]
    layoutPosRef.current = positions
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
    if (actionSelection.size === 0) return
    setHiddenTables(prev => {
      const next = new Set(prev[viewKey] ?? [])
      actionSelection.forEach(id => next.add(id))
      return { ...prev, [viewKey]: next }
    })
    setSelectedTables(new Set()); setHighlightTable(null)
  }, [actionSelection, viewKey])

  const showHiddenTables = useCallback(() => {
    setHiddenTables(prev => {
      if (!prev[viewKey]?.size) return prev
      const next = { ...prev }
      delete next[viewKey]
      return next
    })
  }, [viewKey])

  const deleteSelectedFromLayout = useCallback(() => {
    if (!activeLayout || actionSelection.size === 0 || dslStatusRef.current.status !== 'idle') return
    stageDeletion(actionSelection, activeLayout.id)
  }, [activeLayout, actionSelection, stageDeletion])

  const t = T[lang]
  const handleEdit = useCallback((table: Table) => {
    if (dslStatusRef.current.status === 'idle') setEditorState(table.name)
  }, [])

  const dslSchema = useMemo(
    () => splitView && schema ? serializeSchema(schema, layoutPositions) : schema,
    [splitView, schema, layoutPositions, serializeSchema],
  )

  // Export the whole schema to a draw.io file — one page per TraVis layout
  // plus an "All tables" page, switchable as tabs in draw.io (like sheets in
  // a spreadsheet), each keeping that view's own table set and positions.
  const getDrawioContent = (schemaOut: Schema, positions: DrawioPage['positions']) => {
    const pages: DrawioPage[] = [
      {
        name: lang === 'ru' ? 'Все таблицы' : 'All tables',
        tables: schemaOut.tables,
        positions,
      },
      ...(schemaOut.layouts ?? []).map(l => ({
        name: l.name,
        tables: schemaOut.tables.filter(t => l.tables.includes(t.name)),
        positions: l.positions,
      })),
    ]
    return exportDrawio(pages)
  }

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
    schemaRef.current = schemaToUse
    setSchema(schemaToUse)
    persistSession(serializeSchema(schemaToUse))
    const { nodes: n, edges: e } = schemaToFlow(schemaToUse, handleEdit, masterPositionsRef.current, currentNodes)
    setNodes(n)
    setEdges(e)
  }, [handleEdit, setNodes, setEdges, persistSession, serializeSchema])

  const handleSchemaFromEditor = useCallback((newSchema: Schema, masterPositions?: Record<string, { x: number; y: number }>) => {
    // the editor's text is the new ground truth for any positions it touched —
    // override the live per-layout cache so applySchema's "keep live edits"
    // fallback (meant to protect in-session drags on reopen) doesn't clobber
    // what was just typed with stale in-memory values
    layoutPosRef.current = Object.fromEntries((newSchema.layouts ?? []).map(l => [l.id, l.positions]))
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
      if (session.schema.tables.length > 0 && !hasPositions) setTimeout(() => setPendingELK(true), 250)
    }
  }, [session, applySchema, applyViewMode])

  // immediate, un-debounced session save — used right after a computed
  // (non-drag) position change, e.g. Organize, so a fast reload can't race
  // past the drag-debounced autosave below and revert to a stale snapshot
  const persistSessionNow = useCallback(() => {
    if (!schema) return
    persistSession(serializeSchema(schema))
  }, [schema, serializeSchema, persistSession])

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
  // Save.
  const handleSave = useCallback(async () => {
    if (!schema) return
    const schemaOut = serializeSchema(schema)
    const saved = currentSave.current
    let name = saved?.name

    if (fileHandle) {
      const extension = fileHandle.name.split('.').pop()?.toLowerCase()
      const isSql  = extension === 'sql'
      const isJson = extension === 'json'
      if (!isSql && !isJson) {
        downloadJSON(schemaOut, masterPositionsRef.current)
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
        downloadJSON(schemaOut, masterPositionsRef.current)
        dialog.alert(
          lang === 'ru' ? 'Ошибка записи' : 'Write failed',
          lang === 'ru' ? 'Не удалось сохранить в файл. Схема скачана как копия.' : 'Could not write to file. Schema downloaded as a copy instead.'
        )
        return
      }
      name = name ?? fileHandle.name.replace(/\.[^.]+$/, '')
    } else if (!saved) {
      const promptedName = await dialog.prompt(
        lang === 'ru' ? 'Имя проекта' : 'Project name',
        lang === 'ru' ? 'Введите имя для сохранения в списке проектов' : 'Enter a name to save this project under',
        schema.tables[0]?.name ?? (lang === 'ru' ? 'Без названия' : 'Untitled')
      )
      if (promptedName === null) return
      name = promptedName.trim() || (lang === 'ru' ? 'Без названия' : 'Untitled')
    }

    const entry = saveDB(name!, schemaOut, masterPositionsRef.current, saved?.id)
    currentSave.current = { id: entry.id, name: entry.name }
    persistSession(schemaOut)

    setSaveFlash(true)
    setTimeout(() => setSaveFlash(false), 1500)
    dialog.alert(lang === 'ru' ? 'Сохранение' : 'Saved', lang === 'ru' ? 'Изменения успешно сохранены!' : 'All changes have been successfully saved.')
  }, [schema, fileHandle, dialog, lang, serializeSchema, persistSession])

  const handleExport = async (format: ExportFormat) => {
    if (!schema || exporting) return
    const { label, mimeType } = EXPORT_FORMATS[format]
    const title = lang === 'ru' ? `Экспорт ${label}` : `Export ${label}`
    setExporting(true)

    try {
      // Open the picker while the browser still has the export click's activation.
      const handle = await pickSaveFile(format, mimeType, label)
      if (handle === null) return

      const schemaOut = serializeSchema(schema)
      const positions = masterPositionsRef.current

      let filename = `schema.${format}`
      if (!handle) {
        const name = await dialog.prompt(
          lang === 'ru' ? 'Имя файла' : 'Filename',
          t.exportDownloadHint,
          'schema',
        )
        if (name === null) return
        filename = withExt(name, format)
      }

      let content: string
      switch (format) {
        case 'json':
          content = JSON.stringify(schemaToStructured(schemaOut, positions), null, 2)
          break
        case 'sql':
          content = exportSQL(schemaOut)
          break
        case 'drawio':
          content = getDrawioContent(schemaOut, positions)
          break
      }

      if (handle) {
        await writeToHandle(handle, content)
        await dialog.alert(title, lang === 'ru' ? 'Файл сохранён.' : 'File saved.')
      } else {
        downloadTextFile(content, mimeType, filename)
      }
    } catch (error) {
      console.error('Could not export schema', error)
      await dialog.alert(title, lang === 'ru' ? 'Не удалось сохранить файл.' : 'Could not save the file.')
    } finally {
      setExporting(false)
    }
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); handleSave() }
      if (e.key === 'Escape') clearHighlight()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [handleSave, clearHighlight])

  const handleExit = useCallback(() => {
    hasExited.current = true
    onProjectExit()
  }, [onProjectExit])

  const handleEditorSave = useCallback((updated: Table, originalName: string | null) => {
    if (!schema || dslStatusRef.current.status !== 'idle') return
    let newTables: Table[]
    let positions = masterPositionsRef.current
    if (originalName === null) {
      newTables = [...schema.tables, updated]
      positions = { ...positions }
      let rightmost: { id: string; right: number; y: number } | undefined
      for (const node of nodesRef.current) {
        const position = positions[node.id] ?? node.position
        positions[node.id] = position
        const right = position.x + sizeOf(node.id).width
        if (!rightmost || right > rightmost.right) rightmost = { id: node.id, right, y: position.y }
      }
      // Assign a position before schemaToFlow lays out the new table by itself.
      positions[updated.name] = rightmost
        ? { x: rightmost.right + SIDE_GAP_CLEARANCE, y: rightmost.y }
        : { x: 0, y: 0 }
      const visibleInMainView = !scopedVisibleNames && !hiddenNames.has(updated.name) &&
        (activeTypeFilter.size === 0 || (updated.type && activeTypeFilter.has(updated.type)))
      if (rightmost && visibleInMainView) {
        pendingNewTableFit.current = { tableId: updated.name, neighborId: rightmost.id }
      }
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
    applySchema({ ...schema, tables: newTables }, undefined, positions)
  }, [schema, applySchema, sizeOf, scopedVisibleNames, hiddenNames, activeTypeFilter])

  const deleteTables = useCallback(async (names: ReadonlySet<string>) => {
    const validation = dslStatusRef.current
    if (!schema || names.size === 0 || validation.status !== 'idle') return
    const selectedNames = [...names]
    const title = names.size === 1 ? t.deleteTableTitle : t.deleteTablesTitle
    const message = names.size === 1 ? t.deleteConfirm(selectedNames[0]) : t.deleteTablesConfirm(selectedNames)
    const ok = await dialog.confirm(title, message)
    if (!ok || hasExited.current || validation !== dslStatusRef.current) return
    stageDeletion(names, null)
  }, [schema, stageDeletion, t, dialog])

  const commitDeletions = useCallback((deletions: PendingDeletion[]) => {
    const current = schemaRef.current
    if (!current || hasExited.current) return
    setDeletionVersion(version => version + 1)
    const names = pendingTableNames(deletions, null)
    const layouts = serializeSchema(current).layouts?.map(layout => {
      const removed = pendingTableNames(deletions, layout.id)
      if (removed.size === 0) return layout
      return {
        ...layout,
        tables: layout.tables.filter(name => !removed.has(name)),
        positions: Object.fromEntries(Object.entries(layout.positions).filter(([name]) => !removed.has(name))),
      }
    })
    layoutPosRef.current = Object.fromEntries((layouts ?? []).map(layout => [layout.id, layout.positions]))

    if (names.size === 0) {
      const next = { ...current, layouts }
      schemaRef.current = next
      setSchema(next)
      persistSession(next)
      return
    }

    const tables = current.tables.filter(table => !names.has(table.name)).map(table => ({
      ...table,
      columns: table.columns.map(column => column.foreignKey && names.has(column.foreignKey.table)
        ? { ...column, foreignKey: undefined }
        : column),
    }))
    const positions = Object.fromEntries(Object.entries(masterPositionsRef.current).filter(([name]) => !names.has(name)))
    setHiddenTables(prev => Object.fromEntries(Object.entries(prev).map(([key, hidden]) => [
      key, new Set([...hidden].filter(name => !names.has(name))),
    ])))
    applySchema({ ...current, tables, layouts }, nodesRef.current, positions)
  }, [applySchema, persistSession, serializeSchema])

  useEffect(() => {
    const next = pendingDeletions.find(deletion => !canvasReadOnly || !deletion.expired)
    if (!next) return

    const timer = setTimeout(() => {
      const now = Date.now()
      const queue = pendingDeletionsRef.current
      // Finish once the draft has applied so a pending DSL edit cannot
      // accidentally reintroduce a table that the timer removed.
      if (dslStatusRef.current.status !== 'idle') {
        updatePendingDeletions(queue.map(deletion =>
          deletion.expiresAt <= now && !deletion.expired ? { ...deletion, expired: true } : deletion
        ))
        return
      }
      const due = queue.filter(deletion => deletion.expiresAt <= now)
      if (due.length > 0) commitDeletions(due)
      updatePendingDeletions(queue.filter(deletion => deletion.expiresAt > now))
    }, Math.max(0, next.expiresAt - Date.now()))

    return () => clearTimeout(timer)
  }, [pendingDeletions, canvasReadOnly, commitDeletions, updatePendingDeletions])

  const handleDelete = useCallback((tableName: string) => deleteTables(new Set([tableName])), [deleteTables])

  const handleOpen = useCallback((result: OpenResult) => {
    setFileHandle(result.fileHandle ?? null)
    currentSave.current = result.saveId && result.saveName ? { id: result.saveId, name: result.saveName } : undefined
    // a JSON export's "All tables" entry is the master view's own positions,
    // not a real named layout — pull it back out before it's treated as one
    const allTablesLayout = result.schema.layouts?.find(l => l.name === 'All tables')
    const remaining = allTablesLayout ? result.schema.layouts!.filter(l => l !== allTablesLayout) : undefined
    const schemaToOpen = allTablesLayout ? { ...result.schema, layouts: remaining!.length ? remaining : undefined } : result.schema
    const positions = allTablesLayout?.positions ?? result.positions
    applySchema(schemaToOpen, undefined, positions)
    const hasPositions = positions && Object.keys(positions).length > 0
    if (schemaToOpen.tables.length > 0 && !hasPositions) setTimeout(() => setPendingELK(true), 250)
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
          <RepositoryLink />
        </div>

        {/* Canvas toolbar — groups, view mode, layouts, organize, schema editor */}
        <div className={appStyles.canvasToolbar}>

          {/* Groups — multi-select checkboxes, OR-filtered, scoped + independent per view (see scopedTags/activeTagFilter) */}
          <div className={appStyles.groupsPill} ref={groupsBtnRef}>
            <button
              onClick={() => setGroupsOpen(!groupsOpen)}
              disabled={canvasReadOnly}
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
            {groupsOpen && !canvasReadOnly && (
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

          {/* Types — show/hide by architectural table type (see typeHidden) */}
          <div className={appStyles.groupsPill} ref={typesBtnRef}>
            <button
              onClick={() => setTypesOpen(o => !o)}
              disabled={canvasReadOnly}
              className={`${appStyles.groupsBtn} ${activeTypeFilter.size > 0 ? appStyles.groupsBtnFiltered : ''}`}
            >
              <span className={appStyles.toolBtnIcon}>▤</span>
              <span className={appStyles.toolBtnLabel}>
                {activeTypeFilter.size > 0
                  ? (lang === 'ru' ? `Типов: ${activeTypeFilter.size}` : `${activeTypeFilter.size} types`)
                  : (lang === 'ru' ? 'Типы' : 'Types')}
              </span>
              <span className={appStyles.groupsChevron}>▼</span>
            </button>
            {typesOpen && !canvasReadOnly && (
              <div className={appStyles.groupsDropdown}>
                <button
                  onClick={clearActiveTypeFilter}
                  className={`${appStyles.groupsAllBtn} ${activeTypeFilter.size === 0 ? appStyles.groupsAllBtnActive : ''}`}
                >
                  <span>{lang === 'ru' ? 'Все типы' : 'All types'}</span>
                  {activeTypeFilter.size === 0 && <span>✓</span>}
                </button>
                <div className={appStyles.groupsDivider} />
                {scopedTypes.length === 0 && (
                  <div className={appStyles.layoutEmpty}>
                    {lang === 'ru' ? 'Типы не заданы' : 'No types set'}
                  </div>
                )}
                {scopedTypes.map(tt => (
                  <button
                    key={tt.value}
                    onClick={() => toggleActiveType(tt.value)}
                    className={`${appStyles.groupsTagBtn} ${activeTypeFilter.has(tt.value) ? appStyles.groupsTagBtnActive : ''}`}
                  >
                    <div className={appStyles.groupsTagLeft}>
                      <span className={`${appStyles.groupsCheckbox} ${activeTypeFilter.has(tt.value) ? appStyles.groupsCheckboxChecked : ''}`}>
                        {activeTypeFilter.has(tt.value) && '✓'}
                      </span>
                      <span>{lang === 'ru' ? tt.ru : tt.en}</span>
                    </div>
                    <span className={appStyles.groupsTagCount}>{tt.count}</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* View mode — custom dropdown rather than a native <select>, whose
              option list is drawn by the OS and looks foreign next to the
              rest of the (fully custom) toolbar */}
          <div className={appStyles.groupsPill} ref={viewModeBtnRef}>
            <button
              onClick={() => setViewModeOpen(o => !o)}
              disabled={canvasReadOnly}
              className={appStyles.groupsBtn}
            >
              <span className={appStyles.toolBtnLabel}>{VIEW_MODES.find(m => m.value === viewMode)?.[lang]}</span>
              <span className={appStyles.groupsChevron}>▼</span>
            </button>
            {viewModeOpen && !canvasReadOnly && (
              <div className={`${appStyles.groupsDropdown} ${appStyles.groupsDropdownNarrow}`}>
                {VIEW_MODES.map(m => (
                  <button
                    key={m.value}
                    onClick={() => { handleViewMode(m.value); setViewModeOpen(false) }}
                    className={`${appStyles.groupsAllBtn} ${viewMode === m.value ? appStyles.groupsAllBtnActive : ''}`}
                  >
                    <span>{m[lang]}</span>
                    {viewMode === m.value && <span>✓</span>}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Layouts */}
          <div className={appStyles.groupsPill} ref={layoutsBtnRef}>
            <button
              onClick={() => setLayoutsOpen(o => !o)}
              disabled={canvasReadOnly}
              className={`${appStyles.groupsBtn} ${activeLayout ? appStyles.groupsBtnFiltered : ''}`}
            >
              <span className={appStyles.toolBtnIcon}>▦</span>
              <span className={appStyles.toolBtnLabel}>
                {activeLayout ? activeLayout.name : (lang === 'ru' ? 'Слои' : 'Layouts')}
              </span>
              <span className={appStyles.groupsChevron}>▼</span>
            </button>
            {layoutsOpen && !canvasReadOnly && (
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
                disabled={canvasReadOnly}
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
              disabled={layouting || canvasReadOnly}
              className={`${appStyles.toolBtn} ${layouting ? appStyles.toolBtnDisabled : ''}`}
              title="Auto-arrange tables (ELK)"
            >
              <span className={appStyles.toolBtnIcon} style={layouting ? { display: 'inline-block', transform: 'rotate(90deg)' } : undefined}>⟳</span>
              <span className={appStyles.toolBtnLabel}>{layouting ? '...' : 'Organize'}</span>
            </button>
          </div>

          {/* Schema editor split view */}
          <div className={appStyles.toolPill}>
            <button
              onClick={() => setSplitView(v => !v)}
              className={`${appStyles.toolBtn} ${splitView ? appStyles.toolBtnActive : ''}`}
              title={lang === 'ru' ? 'Переключить редактор схемы (DSL)' : 'Toggle schema editor (DSL)'}
              aria-pressed={splitView}
            >
              <span style={{ fontSize: 13, fontFamily: 'monospace', fontWeight: 600 }}>{'{}'}</span>
              <span className={appStyles.toolBtnLabel}>{lang === 'ru' ? 'Схема' : 'Schema'}</span>
            </button>
          </div>
        </div>

        <div className={appStyles.topbarRight}>
          <button
            onClick={() => void handleExport('json')}
            disabled={exporting}
            className={appStyles.exportBtn}
          >
            ↓ JSON
          </button>
          <button
            onClick={() => void handleExport('sql')}
            disabled={exporting}
            className={appStyles.exportBtn}
          >
            ↓ SQL
          </button>
          <button
            onClick={() => void handleExport('drawio')}
            disabled={exporting}
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
                  <SchemaEditor
                    schema={dslSchema ?? schema}
                    masterPositions={masterPositionsRef.current}
                    deletionVersion={deletionVersion}
                    draftRef={dslDraftRef}
                    onSchemaChange={handleSchemaFromEditor}
                    onStatusChange={handleDSLStatus}
                    width={editorWidth}
                  />
                </div>
                <div className={appStyles.resizeHandle} onMouseDown={handleResizeStart} />
              </>
            ) : (
              <Sidebar
                tables={schema.tables.filter(table => !pendingGlobal.has(table.name))}
                lang={lang}
                readOnly={canvasReadOnly}
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
              {!canvasReadOnly && <div className={appStyles.topLeftFabRow}>
                {/* Create-layout button — appears when a table (or group) is selected */}
                {actionSelection.size > 0 && !activeLayout && (
                  <button className={`${appStyles.createLayoutFab} ${appStyles.fabInWrap}`} onClick={createLayoutFromSelection}>
                    <span className={appStyles.createLayoutFabIcon}>▦</span>
                    {lang === 'ru' ? 'Создать слой' : 'Create layout'}
                    <span className={appStyles.createLayoutFabCount}>{actionSelection.size}</span>
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
                {actionSelection.size > 0 && (
                  <button className={`${appStyles.actionFab} ${appStyles.fabInWrap}`} onClick={hideSelected}>
                    <span className={appStyles.createLayoutFabIcon}>⊘</span>
                    {lang === 'ru' ? 'Скрыть' : 'Hide'}
                    <span className={appStyles.createLayoutFabCount}>{actionSelection.size}</span>
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

                {actionSelection.size > 0 && (
                  <button
                    className={`${appStyles.actionFab} ${appStyles.actionFabDanger} ${appStyles.fabInWrap}`}
                    onClick={activeLayout ? deleteSelectedFromLayout : () => deleteTables(actionSelection)}
                    title={activeLayout ? t.deleteFromLayout : t.deleteFromSchema}
                  >
                    <span className={appStyles.createLayoutFabIcon}>🗑</span>
                    {activeLayout ? t.removeFromLayout : t.delete}
                    <span className={appStyles.createLayoutFabCount}>{actionSelection.size}</span>
                  </button>
                )}
              </div>}

              {/* Add-to-layout — quick-add the selection to any OTHER existing layout */}
              {!canvasReadOnly && actionSelection.size > 0 && (schema.layouts ?? []).some(l => l.id !== activeLayoutId) && (
                <div className={appStyles.addToLayoutWrap}>
                  <button
                    className={`${appStyles.createLayoutFab} ${appStyles.fabInWrap}`}
                    onClick={() => setAddToLayoutOpen(o => !o)}
                  >
                    <span className={appStyles.createLayoutFabIcon}>⤵</span>
                    {lang === 'ru' ? 'Добавить в слой' : 'Add to layout'}
                    <span className={appStyles.createLayoutFabCount}>{actionSelection.size}</span>
                  </button>
                  {addToLayoutOpen && (
                    <div className={appStyles.addToLayoutMenu}>
                      {(schema.layouts ?? []).filter(l => l.id !== activeLayoutId).map(l => (
                        <button
                          key={l.id}
                          className={appStyles.addToLayoutItem}
                          onClick={() => {
                            addTablesToLayout([...actionSelection], l.id)
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

              <div className={appStyles.toastStack}>
                {pendingDeletions.slice().reverse().filter(deletion => !deletion.expired).map(deletion => (
                  <div key={deletion.id} className={appStyles.toast}>
                    <span role="status">{deletion.layoutId
                      ? t.removedFromLayout(deletion.names.size)
                      : t.removedFromSchema(deletion.names.size)}</span>
                    <button className={appStyles.undoBtn} onClick={() => undoDeletion(deletion)}>
                      {t.undo}
                      <svg className={appStyles.undoTimer} aria-hidden="true" viewBox="0 0 20 20">
                        <circle cx="10" cy="10" r="8" className={appStyles.undoTrack} />
                        <circle cx="10" cy="10" r="8" pathLength="100" className={appStyles.undoProgress}
                          style={{ animationDuration: `${DELETE_UNDO_MS}ms` }} />
                      </svg>
                    </button>
                  </div>
                ))}
                {toast && <div className={appStyles.toast} role="status">{toast}</div>}
              </div>

              <ThemeCtx.Provider value={theme}>
              <ViewModeCtx.Provider value={{ mode: viewMode, bulkExpand, bulkKey, readOnly: canvasReadOnly }}>
                <HighlightCtx.Provider value={highlightCtxValue}>
                 <EdgeHoverCtx.Provider value={edgeHoverCtxValue}>
                    <ReactFlow
                      nodes={displayNodes}
                      edges={displayEdges}
                      onNodesChange={handleNodesChange}
                      onEdgesChange={canvasReadOnly ? undefined : onEdgesChange}
                      onNodeDragStart={handleNodeDragStart}
                      onNodeDrag={handleNodeDrag}
                      onNodeDragStop={handleNodeDragStop}
                      onSelectionChange={canvasReadOnly ? undefined : handleSelectionChange}
                      onNodeClick={canvasReadOnly ? undefined : handleNodeClick}
                      onNodeContextMenu={canvasReadOnly ? undefined : handleNodeContextMenu}
                      onPaneClick={canvasReadOnly ? undefined : clearHighlight}
                      nodeTypes={NODE_TYPES}
                      edgeTypes={EDGE_TYPES}
                      fitView
                      fitViewOptions={{ padding: 0.2 }}
                      minZoom={0.05}
                      nodesDraggable={!canvasReadOnly && !activeLayout?.locked}
                      nodesConnectable={!canvasReadOnly}
                      elementsSelectable={!canvasReadOnly}
                      deleteKeyCode={canvasReadOnly ? null : undefined}
                      selectionMode={SelectionMode.Partial}
                      panOnDrag={[2]}
                      selectionOnDrag={!canvasReadOnly}
                      selectNodesOnDrag={false}
                      multiSelectionKeyCode={null}
                      panOnScroll={true}
                      onInit={instance => { rfInstanceRef.current = instance }}
                    >
                      <NodesInitializedFitView rfRef={rfInstanceRef} />
                      <NodeMeasureSync onMeasured={handleMeasured} />
                      <Background color={theme === 'dark' ? '#1a1d27' : '#dde0e6'} gap={20} />
                      <Controls
                        showInteractive={false}
                        className={appStyles.reactFlowControls}
                      />
                      <MiniMap
                        style={{ background: 'var(--bg-panel)', borderRadius: 16, border: '1px solid rgba(var(--overlay-rgb),0.08)', overflow: 'hidden' }}
                        nodeColor={n => tableAccent((n.data as TableNodeData).table)}
                        maskColor="rgba(0,0,0,0.6)"
                      />
                    </ReactFlow>
                 </EdgeHoverCtx.Provider>
                </HighlightCtx.Provider>
              </ViewModeCtx.Provider>
              </ThemeCtx.Provider>

              {canvasReadOnly && (
                <div className={appStyles.freezeBanner} role="status">
                  {dslStatus === 'checking'
                    ? (lang === 'ru' ? 'Проверка DSL…' : 'Checking DSL…')
                    : (lang === 'ru' ? 'Холст только для просмотра. Исправьте ошибки в DSL.' : 'Canvas is read-only. Fix the errors in DSL.')}
                </div>
              )}

              {/* Dragging is disabled (nodesDraggable above) while the active
                  layout is locked — tables can still be selected/edited. */}
              {!canvasReadOnly && activeLayout?.locked && (
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
  const accent = tableAccent(table)
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
