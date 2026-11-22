import { useState, useRef, memo, useContext, useEffect } from 'react'
import { Handle, Position, useNodeId, useUpdateNodeInternals, type NodeProps } from '@xyflow/react'
import { tableAccent } from '../../utils/colors'
import { HighlightCtx } from '../../contexts/highlight'
import { EdgeHoverCtx } from '../../contexts/edgeHover'
import { ViewModeCtx } from '../../contexts/viewMode'
import type { Table, Column } from '../../types/schema'
import styles from './TableNode.module.css'

export interface TableNodeData extends Record<string, unknown> {
  table: Table
  onEdit: (table: Table) => void
}

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

function ColumnRow({ col, accent, linked, hidden }: {
  col: Column; accent: string; linked: boolean; hidden: boolean
}) {
  return (
    <div className={`${styles.columnRow} ${linked ? styles.columnRowLinked : ''} ${hidden ? styles.columnRowHidden : ''}`}>
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

export const TableNode = memo(({ data }: NodeProps) => {
  const { table, onEdit } = data as TableNodeData
  const [expanded, setExpanded] = useState(true)
  const hl = useContext(HighlightCtx)
  const edgeHover = useContext(EdgeHoverCtx)
  const { mode: viewMode, bulkKey, bulkExpand, readOnly } = useContext(ViewModeCtx)
  const accent = tableAccent(table)
  const lastAppliedKey = useRef(0)
  const nodeId = useNodeId()
  const updateNodeInternals = useUpdateNodeInternals()

  useEffect(() => {
    if (bulkKey > lastAppliedKey.current) {
      setExpanded(bulkExpand)
      lastAppliedKey.current = bulkKey
    }
  }, [bulkKey, bulkExpand])

  // The left/right connection handles sit vertically centered on the node's
  // current height, which changes when the table folds/unfolds — React Flow
  // has to re-measure them (once now and once after the 0.28s open/close
  // animation settles) or edges keep aiming at the old center.
  useEffect(() => {
    if (!nodeId) return
    updateNodeInternals(nodeId)
    const t = setTimeout(() => updateNodeInternals(nodeId), 320)
    return () => clearTimeout(t)
  }, [expanded, nodeId, updateNodeInternals])

  const isHighlighted = hl.active && hl.highlighted.has(table.name)
  const isDimmed = hl.active && !hl.highlighted.has(table.name)
  const isFocus = hl.active && hl.focusTable === table.name
  const isSelected = hl.selected.has(table.name)

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

  const handleModifiedClick = (e: React.MouseEvent) => {
    if (!e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) return
    e.stopPropagation()
    if (e.ctrlKey || e.metaKey) {
      hl.onHighlight(table.name, 'toggle')
    } else {
      hl.onHighlight(table.name, e.shiftKey ? 'related' : 'exclusive')
    }
  }

  const handleModifiedMouseDown = (e: React.MouseEvent) => {
    if (e.altKey || e.metaKey || e.ctrlKey || e.shiftKey) e.stopPropagation()
  }

  const nodeClass = [
    styles.node,
    isHighlighted ? styles.nodeHighlighted : '',
    isFocus ? styles.nodeFocus : '',
    isSelected ? styles.nodeSelected : '',
    isDimmed ? styles.nodeDimmed : '',
  ].filter(Boolean).join(' ')

  return (
    <div
      // React Flow uses `nokey` to keep Shift+click on a card out of the selection rectangle.
      className={`${nodeClass} nokey`}
      onClick={handleModifiedClick}
      onMouseDown={handleModifiedMouseDown}
      style={{ '--accent': accent, '--accent-glow': `${accent}55`, '--accent-glow2': `${accent}44` } as React.CSSProperties}
    >
      {/* One generic connection point per side of the whole card, not per
          column — App.tsx picks whichever side of each table an edge should
          use (whichever pair is closest, see pickBestSides) and fans out
          multiple edges sharing one side, then hands down the exact draw
          point via edge data (see OrthoEdge); these handles only need to
          exist so React Flow's own bookkeeping resolves a valid connection,
          their on-screen position never actually determines where a line is
          drawn. Always present regardless of expand/collapse — anchored to
          the outer card, not to a row that might be hidden. */}
      <Handle type="target" position={Position.Top} id="top" style={{ opacity: 0, width: 8, height: 8 }} />
      <Handle type="source" position={Position.Top} id="top" style={{ opacity: 0, width: 8, height: 8 }} />
      <Handle type="target" position={Position.Bottom} id="bottom" style={{ opacity: 0, width: 8, height: 8 }} />
      <Handle type="source" position={Position.Bottom} id="bottom" style={{ opacity: 0, width: 8, height: 8 }} />
      <Handle type="target" position={Position.Left} id="left" style={{ opacity: 0, width: 8, height: 8 }} />
      <Handle type="source" position={Position.Left} id="left" style={{ opacity: 0, width: 8, height: 8 }} />
      <Handle type="target" position={Position.Right} id="right" style={{ opacity: 0, width: 8, height: 8 }} />
      <Handle type="source" position={Position.Right} id="right" style={{ opacity: 0, width: 8, height: 8 }} />

      <div className={styles.header}>
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
            disabled={readOnly}
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
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  )
})
