import React, { useState, useContext } from 'react'
import {
  getSmoothStepPath,
  EdgeLabelRenderer,
  type EdgeProps,
} from '@xyflow/react'
import { HighlightCtx } from '../../contexts/highlight'
import { EdgeHoverCtx } from '../../contexts/edgeHover'
import styles from './OrthoEdge.module.css'

export interface OrthoEdgeData extends Record<string, unknown> {
  label: string
  color: string
  relType?: '1:1' | '1:N' | 'N:M'
  sourceColor?: string
  targetColor?: string
  sourceColumn?: string
  targetColumn?: string
}

const LABEL_OFF = 24

const POS_DIR: Record<string, { dx: number; dy: number }> = {
  right: { dx: 1, dy: 0 }, left: { dx: -1, dy: 0 },
  top: { dx: 0, dy: -1 }, bottom: { dx: 0, dy: 1 },
}

export function OrthoEdge({
  id,
  sourceX, sourceY, targetX, targetY,
  sourcePosition, targetPosition,
  source, target,
  data,
}: EdgeProps) {
  const [hovered, setHovered] = useState(false)
  const { label, color, relType, sourceColor, targetColor, sourceColumn, targetColumn } = (data ?? {}) as OrthoEdgeData
  const hl = useContext(HighlightCtx)
  const edgeHover = useContext(EdgeHoverCtx)

  const enterHover = () => {
    setHovered(true)
    if (sourceColumn && targetColumn) {
      edgeHover.setHover({
        source: { table: source, column: sourceColumn },
        target: { table: target, column: targetColumn },
      })
    }
  }
  const leaveHover = () => {
    setHovered(false)
    edgeHover.setHover(null)
  }

  const bothLit = hl.highlighted.has(source) && hl.highlighted.has(target)
  const touchesFocus = source === hl.focusTable || target === hl.focusTable
  // group mode: any edge between two selected tables lights up.
  // normal mode: only edges touching the focused table (its direct FKs).
  const edgeHighlighted = hl.active && (hl.groupMode ? bothLit : (touchesFocus && bothLit))
  const edgeDimmed = hl.active && !edgeHighlighted

  const activeColor = edgeHighlighted
    ? (source === hl.focusTable ? sourceColor : targetColor) ?? color
    : color

  const [edgePath, labelX, labelY] = getSmoothStepPath({
    sourceX, sourceY, targetX, targetY,
    sourcePosition, targetPosition,
    borderRadius: 0,
  })

  const startDot = { x: sourceX, y: sourceY }
  const endDot   = { x: targetX, y: targetY }
  const sd = POS_DIR[sourcePosition] ?? { dx: 1, dy: 0 }
  const td = POS_DIR[targetPosition] ?? { dx: -1, dy: 0 }
  const srcLabelX = startDot.x + sd.dx * LABEL_OFF
  const srcLabelY = startDot.y + sd.dy * LABEL_OFF
  const endLabelX = endDot.x + td.dx * LABEL_OFF
  const endLabelY = endDot.y + td.dy * LABEL_OFF

  const srcLabel = relType === '1:1' ? '1' : 'n'
  const endLabel = relType === 'N:M' ? 'm' : '1'

  const svgTextStyle: React.CSSProperties = { pointerEvents: 'none', userSelect: 'none' }

  return (
    <>
      <path
        d={edgePath}
        fill="none"
        stroke="transparent"
        strokeWidth={16}
        onMouseEnter={enterHover}
        onMouseLeave={leaveHover}
        style={{ cursor: 'default' }}
      />
      {edgeHighlighted && (
        <path
          d={edgePath}
          fill="none"
          stroke={activeColor}
          strokeWidth={6}
          strokeOpacity={0.25}
          style={{ pointerEvents: 'none', filter: 'blur(3px)' }}
        />
      )}
      <path
        id={id}
        d={edgePath}
        fill="none"
        stroke={activeColor}
        strokeWidth={edgeHighlighted ? 2.5 : hovered ? 2.5 : 1.5}
        strokeOpacity={edgeDimmed ? 0.06 : 1}
        style={{ transition: 'stroke-width 0.15s, stroke-opacity 0.2s', pointerEvents: 'none' }}
      />
      <circle cx={startDot.x} cy={startDot.y} r={edgeHighlighted ? 5 : 4} fill={activeColor}
        opacity={edgeDimmed ? 0.06 : 1} style={{ pointerEvents: 'none' }} />
      <circle cx={endDot.x} cy={endDot.y} r={edgeHighlighted ? 5 : 4} fill={activeColor}
        opacity={edgeDimmed ? 0.06 : 1} style={{ pointerEvents: 'none' }} />

      {relType && !edgeDimmed && (
        <>
          <text x={srcLabelX} y={srcLabelY} textAnchor="middle" dominantBaseline="middle"
            fontSize={10} fontWeight={700} fontFamily="monospace"
            stroke="#0d0f17" strokeWidth={3} paintOrder="stroke"
            fill={activeColor} opacity={edgeHighlighted ? 1 : 0.7}
            style={svgTextStyle}>
            {srcLabel}
          </text>
          <text x={endLabelX} y={endLabelY} textAnchor="middle" dominantBaseline="middle"
            fontSize={10} fontWeight={700} fontFamily="monospace"
            stroke="#0d0f17" strokeWidth={3} paintOrder="stroke"
            fill={activeColor} opacity={edgeHighlighted ? 1 : 0.7}
            style={svgTextStyle}>
            {endLabel}
          </text>
        </>
      )}

      <EdgeLabelRenderer>
        {(hovered || edgeHighlighted) && (
          <div
            className={styles.labelWrapper}
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)` }}
          >
            <div
              className={styles.label}
              style={{
                '--label-border': `${activeColor}${edgeHighlighted ? 'cc' : '55'}`,
                '--label-color': activeColor,
                '--label-shadow': edgeHighlighted
                  ? `0 0 8px ${activeColor}66, 0 2px 8px rgba(0,0,0,0.6)`
                  : `0 2px 8px rgba(0,0,0,0.6)`,
                '--label-weight': edgeHighlighted ? 700 : 400,
              } as React.CSSProperties}
            >
              {label}
            </div>
          </div>
        )}
      </EdgeLabelRenderer>
    </>
  )
}
