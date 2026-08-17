import { useState, useRef, memo, useContext, useEffect } from 'react'
import { Handle, Position, useNodeId, useUpdateNodeInternals, type NodeProps } from '@xyflow/react'
import { tagColor } from '../../utils/colors'
import { MultiSelectCtx } from './TableNode.multiselect'
import { HighlightCtx } from '../../contexts/highlight'
import { EdgeHoverCtx } from '../../contexts/edgeHover'
import { ViewModeCtx } from '../../contexts/viewMode'
import type { Table, Column } from '../../types/schema'
import styles from './TableNode.module.css'

export interface TableNodeData extends Record<string, unknown> {
  table: Table
  onEdit: (table: Table) => void
  // names of this table's columns that some other table's FK points at —
  // used to attach a connection handle only where an edge actually lands
  referencedColumns?: Set<string>
}

const EMPTY_SET = new Set<string>()

export { MultiSelectCtx }

// short header label per architectural table type
const TYPE_LABEL: Record<string, string> = {
  reference: 'REF', master: 'MASTER', transaction: 'TX', link: 'LINK', dimension: 'DIM', fact: 'FACT',
}

const BADGE_COLORS: Record<string, { bg: string; color: string }> = {
  pk:  { bg: 'transparent', color: 'transparent' }, // set dynamically
  fk:  { bg: '#f59e0b33', color: '#f59e0b' },
  uq:  { bg: '#06b6d433', color: '#06b6d4' },
  nil: { bg: '#6b728033', color: '#6b7280' },
}

function Badge({ label, color }: { label: string; color: string }) {
  const isFK = label === 'FK'
  const isUQ = label === 'UQ'
  const isNull = label === '?'
  const bg = isFK ? BADGE_COLORS.fk.bg : isUQ ? BADGE_COLORS.uq.bg : isNull ? BADGE_COLORS.nil.bg : `${color}33`
  const col = isFK ? BADGE_COLORS.fk.color : isUQ ? BADGE_COLORS.uq.color : isNull ? BADGE_COLORS.nil.color : color
  return (
    <span
      className={styles.badge}
      style={{ '--badge-bg': bg, '--badge-color': col } as React.CSSProperties}
    >
      {label}
    </span>
  )
}

function ColumnRow({ col, accent, linked, hidden, referenced, showHandles }: {
  col: Column; accent: string; linked: boolean; hidden: boolean; referenced: boolean; showHandles: boolean
}) {
  return (
    <div className={`${styles.columnRow} ${linked ? styles.columnRowLinked : ''} ${hidden ? styles.columnRowHidden : ''}`}>
      {/* per-column connection points: edges attach to the row that actually
          holds the FK / the referenced key, instead of a single node-wide dot.
          Only while expanded — when collapsed the handles move to the header
          (see TableNode) so edges don't point into the hidden column area.
          Two handles per role (left + right): which one an edge actually
          uses is chosen per-edge in App.tsx based on the two tables' live
          relative position, not fixed by role like it used to be. */}
      {showHandles && referenced && (
        <>
          <Handle type="target" position={Position.Left} id={`col-${col.name}-L`}
            style={{ opacity: 0, width: 8, height: 8, left: -4, top: '50%' }} />
          <Handle type="target" position={Position.Right} id={`col-${col.name}-R`}
            style={{ opacity: 0, width: 8, height: 8, right: -4, top: '50%' }} />
        </>
      )}
      {showHandles && col.foreignKey && (
        <>
          <Handle type="source" position={Position.Left} id={`col-${col.name}-L`}
            style={{ opacity: 0, width: 8, height: 8, left: -4, top: '50%' }} />
          <Handle type="source" position={Position.Right} id={`col-${col.name}-R`}
            style={{ opacity: 0, width: 8, height: 8, right: -4, top: '50%' }} />
        </>
      )}
      <span className={styles.colName}>{col.name}</span>
      <span className={styles.colType}>{col.type}</span>
      <div className={styles.badges}>
        {col.primaryKey && <Badge label="PK" color={accent} />}
        {col.foreignKey && <Badge label="FK" color="#f59e0b" />}
        {col.unique && !col.primaryKey && <Badge label="UQ" color="#06b6d4" />}
        {col.nullable && <Badge label="?" color="#6b7280" />}
      </div>
    </div>
  )
}

export const TableNode = memo(({ data, selected }: NodeProps) => {
  const { table, onEdit, referencedColumns = EMPTY_SET } = data as TableNodeData
  const [expanded, setExpanded] = useState(true)
  const multiSelectActive = useContext(MultiSelectCtx)
  const hl = useContext(HighlightCtx)
  const edgeHover = useContext(EdgeHoverCtx)
  const { mode: viewMode, bulkKey, bulkExpand } = useContext(ViewModeCtx)
  const accent = tagColor(table.tags)
  const lastAppliedKey = useRef(0)
  const nodeId = useNodeId()
  const updateNodeInternals = useUpdateNodeInternals()

  useEffect(() => {
    if (bulkKey > lastAppliedKey.current) {
      setExpanded(bulkExpand)
      lastAppliedKey.current = bulkKey
    }
  }, [bulkKey, bulkExpand])

  // When the table folds/unfolds the connection handles move between the
  // column rows and the header, so React Flow has to re-measure them (once now
  // and once after the 0.28s open/close animation settles) or the edges keep
  // pointing at the handles' old positions.
  useEffect(() => {
    if (!nodeId) return
    updateNodeInternals(nodeId)
    const t = setTimeout(() => updateNodeInternals(nodeId), 320)
    return () => clearTimeout(t)
  }, [expanded, nodeId, updateNodeInternals])

  const isHighlighted = hl.active && hl.highlighted.has(table.name)
  const isDimmed = hl.active && !hl.highlighted.has(table.name)
  const isFocus = hl.active && hl.focusTable === table.name
  const isMultiSelected = multiSelectActive && selected

  // column linked by the currently hovered FK edge (this table's endpoint)
  const linkedCol =
    edgeHover.source?.table === table.name ? edgeHover.source.column
    : edgeHover.target?.table === table.name ? edgeHover.target.column
    : null

  const showColumns = expanded

  // keep every column mounted so full↔compact can animate rows in/out;
  // in compact mode the non-key rows collapse instead of unmounting.
  const orderedColumns = [
    ...table.columns.filter(c => c.primaryKey),
    ...table.columns.filter(c => c.foreignKey && !c.primaryKey),
    ...table.columns.filter(c => !c.primaryKey && !c.foreignKey),
  ]
  const isCompactHidden = (c: Column) => viewMode === 'compact' && !c.primaryKey && !c.foreignKey
  const visibleCount = viewMode === 'compact'
    ? table.columns.filter(c => c.primaryKey || c.foreignKey).length
    : table.columns.length

  const handleHeaderClick = (e: React.MouseEvent) => {
    // Alt+click, Cmd/Ctrl+click and Shift+click all build their own selection
    // group in the app state (see handleTableClick); keep them out of React
    // Flow's native selection, which would otherwise fire its own 1-or-2-node
    // selection change and flatten the FK-focus group down to just the
    // clicked pair.
    // Check both metaKey and ctrlKey: on macOS Ctrl+click is intercepted as
    // the native right-click/context-menu gesture before a click event ever
    // fires (so only metaKey/Cmd is reachable there), but on Windows
    // Ctrl+click is a perfectly normal click with ctrlKey set — checking
    // metaKey alone left Windows users' Ctrl+click falling through to React
    // Flow's native single-select, collapsing whatever group was selected.
    const toggle = e.metaKey || e.ctrlKey
    if (e.altKey || toggle || e.shiftKey) e.stopPropagation()
    hl.onHighlight(table.name, { cmd: toggle, alt: e.altKey, shift: e.shiftKey })
  }

  // Also stop the Alt/Cmd/Ctrl/Shift+mousedown so React Flow's drag/select
  // handler never selects the node (it selects on pointer-down, before the
  // click fires) — Shift in particular is React Flow's own
  // multiSelectionKeyCode, which knows nothing about FK relationships and
  // would otherwise just toggle this one node into its native selection.
  const handleHeaderMouseDown = (e: React.MouseEvent) => {
    if (e.altKey || e.metaKey || e.ctrlKey || e.shiftKey) e.stopPropagation()
  }

  const nodeClass = [
    styles.node,
    isHighlighted ? styles.nodeHighlighted : '',
    isFocus ? styles.nodeFocus : '',
    isMultiSelected ? styles.nodeMultiSelected : '',
    isDimmed ? styles.nodeDimmed : '',
  ].filter(Boolean).join(' ')

  return (
    <div
      className={nodeClass}
      style={{ '--accent': accent, '--accent-glow': `${accent}55`, '--accent-glow2': `${accent}44` } as React.CSSProperties}
    >
      <div className={styles.header} onClick={handleHeaderClick} onMouseDown={handleHeaderMouseDown}>
        {/* When collapsed, all connection points live on the header so edges
            anchor to the header instead of the now-hidden column rows. */}
        {!showColumns && table.columns.map(col => (
          <span key={`h-${col.name}`}>
            {referencedColumns.has(col.name) && (
              <>
                <Handle type="target" position={Position.Left} id={`col-${col.name}-L`}
                  style={{ opacity: 0, width: 8, height: 8, left: -4, top: '50%' }} />
                <Handle type="target" position={Position.Right} id={`col-${col.name}-R`}
                  style={{ opacity: 0, width: 8, height: 8, right: -4, top: '50%' }} />
              </>
            )}
            {col.foreignKey && (
              <>
                <Handle type="source" position={Position.Left} id={`col-${col.name}-L`}
                  style={{ opacity: 0, width: 8, height: 8, left: -4, top: '50%' }} />
                <Handle type="source" position={Position.Right} id={`col-${col.name}-R`}
                  style={{ opacity: 0, width: 8, height: 8, right: -4, top: '50%' }} />
              </>
            )}
          </span>
        ))}
        <span className={styles.headerName}>{table.name}</span>
        <div className={styles.headerRight}>
          {table.type ? (
            <span className={styles.typeBadge}>{TYPE_LABEL[table.type]}</span>
          ) : (
            <span className={styles.colCount}>
              {visibleCount}{viewMode === 'compact' ? `/${table.columns.length}` : ''} cols
            </span>
          )}
          <button
            className={styles.editBtn}
            onClick={e => { e.stopPropagation(); onEdit(table) }}
            title="Edit table"
          >
            Edit
          </button>
          <button
            className={styles.toggleBtn}
            onClick={e => { e.stopPropagation(); setExpanded(x => !x) }}
            title={expanded ? 'Collapse' : 'Expand'}
          >
            {showColumns ? '▲' : '▼'}
          </button>
        </div>
      </div>

      {table.tags && table.tags.length > 0 && (
        <div className={styles.tags}>
          {table.tags.map(tag => (
            <span key={tag} className={styles.tag}>#{tag}</span>
          ))}
        </div>
      )}

      <div className={`${styles.columnsWrap} ${showColumns ? styles.columnsOpen : ''}`}>
        <div className={styles.columnsInner}>
          <div className={styles.columns}>
            {orderedColumns.map(col => (
              <ColumnRow
                key={col.name}
                col={col}
                accent={accent}
                linked={col.name === linkedCol}
                hidden={isCompactHidden(col)}
                referenced={referencedColumns.has(col.name)}
                showHandles={showColumns}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  )
})
