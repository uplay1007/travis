import { useState, useRef, memo, useContext, useEffect } from 'react'
import { Handle, Position, type NodeProps } from '@xyflow/react'
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
}

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

function ColumnRow({ col, accent, linked, hidden }: { col: Column; accent: string; linked: boolean; hidden: boolean }) {
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

export const TableNode = memo(({ data, selected }: NodeProps) => {
  const { table, onEdit } = data as TableNodeData
  const [expanded, setExpanded] = useState(true)
  const multiSelectActive = useContext(MultiSelectCtx)
  const hl = useContext(HighlightCtx)
  const edgeHover = useContext(EdgeHoverCtx)
  const { mode: viewMode, bulkKey, bulkExpand } = useContext(ViewModeCtx)
  const accent = tagColor(table.tags)
  const lastAppliedKey = useRef(0)

  useEffect(() => {
    if (bulkKey > lastAppliedKey.current) {
      setExpanded(bulkExpand)
      lastAppliedKey.current = bulkKey
    }
  }, [bulkKey, bulkExpand])

  const isHighlighted = hl.active && hl.highlighted.has(table.name)
  const isDimmed = hl.active && !hl.highlighted.has(table.name)
  const isFocus = hl.active && hl.focusTable === table.name
  const isMultiSelected = multiSelectActive && selected

  // column linked by the currently hovered FK edge (this table's endpoint)
  const linkedCol =
    edgeHover.source?.table === table.name ? edgeHover.source.column
    : edgeHover.target?.table === table.name ? edgeHover.target.column
    : null

  const showColumns = isMultiSelected ? false : expanded

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
    hl.onHighlight(table.name, { shift: e.shiftKey, alt: e.altKey })
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
      <Handle type="target" position={Position.Left} style={{ opacity: 0, width: 8, height: 8 }} />
      <Handle type="source" position={Position.Right} style={{ opacity: 0, width: 8, height: 8 }} />

      <div className={styles.header} onClick={handleHeaderClick}>
        <span className={styles.headerName}>{table.name}</span>
        {table.type && <span className={styles.typeBadge}>{TYPE_LABEL[table.type]}</span>}
        <div className={styles.headerRight}>
          <span className={styles.colCount}>
            {visibleCount}{viewMode === 'compact' ? `/${table.columns.length}` : ''} cols
          </span>
          {!isMultiSelected && (
            <button
              className={styles.editBtn}
              onClick={e => { e.stopPropagation(); onEdit(table) }}
              title="Edit table"
            >
              Edit
            </button>
          )}
          <button
            className={styles.toggleBtn}
            onClick={e => { e.stopPropagation(); setExpanded(x => !x) }}
            title={expanded ? 'Collapse' : 'Expand'}
          >
            {showColumns ? '▲' : '▼'}
          </button>
        </div>
      </div>

      {!isMultiSelected && table.tags && table.tags.length > 0 && (
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
