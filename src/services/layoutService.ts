import ELK, { type ElkNode, type ElkExtendedEdge, type ElkPort } from 'elkjs/lib/elk.bundled.js'
import type { Schema, Table } from '../types/schema'

const NODE_WIDTH = 280
const COLUMN_HEIGHT = 32
const HEADER_HEIGHT = 44
const TAGS_HEIGHT = 32 
const ROW_WRAP = 3600 
const COMP_GAP_X = 200 
const COMP_GAP_Y = 240

function defaultNodeHeight(cols: number, hasTags: boolean) {
  return HEADER_HEIGHT + (cols * COLUMN_HEIGHT) + 24 + (hasTags ? TAGS_HEIGHT : 0)
}

function getComponents(schema: Schema): string[][] {
  const adj = new Map<string, Set<string>>()
  schema.tables.forEach(t => adj.set(t.name, new Set()))
  for (const t of schema.tables) {
    for (const col of t.columns) {
      if (!col.foreignKey) continue
      const tgt = col.foreignKey.table
      if (!adj.has(tgt)) continue
      adj.get(t.name)!.add(tgt)
      adj.get(tgt)!.add(t.name)
    }
  }
  const visited = new Set<string>()
  const components: string[][] = []
  for (const t of schema.tables) {
    if (visited.has(t.name)) continue
    const group: string[] = []
    const stack = [t.name]
    while (stack.length) {
      const node = stack.pop()!
      if (visited.has(node)) continue
      visited.add(node)
      group.push(node)
      adj.get(node)?.forEach(n => { if (!visited.has(n)) stack.push(n) })
    }
    components.push(group)
  }
  return components.sort((a, b) => b.length - a.length)
}

export interface RoutePoint { x: number; y: number }
export type NodePositions = Record<string, { x: number; y: number }>

// Same PK-first / FK-second / rest-last ordering TableNode renders columns
// in, so a port's position in the FIXED_ORDER list matches its visual row.
function visualColumnOrder(t: Table) {
  return [
    ...t.columns.filter(c => c.primaryKey),
    ...t.columns.filter(c => c.foreignKey && !c.primaryKey),
    ...t.columns.filter(c => !c.primaryKey && !c.foreignKey),
  ]
}

// One ELK port per FK column (EAST, outgoing) and per column some other
// table's FK targets (WEST, incoming), so edges attach — and ELK's crossing
// minimization reasons about attachment — at the specific row, not the node.
function buildPorts(tables: Table[]): Map<string, ElkPort[]> {
  const names = new Set(tables.map(t => t.name))
  const referenced = new Map<string, Set<string>>()
  for (const t of tables) {
    for (const col of t.columns) {
      if (!col.foreignKey || col.foreignKey.table === t.name) continue
      if (!names.has(col.foreignKey.table)) continue
      const set = referenced.get(col.foreignKey.table) ?? new Set<string>()
      set.add(col.foreignKey.column)
      referenced.set(col.foreignKey.table, set)
    }
  }

  const ports = new Map<string, ElkPort[]>()
  for (const t of tables) {
    const ref = referenced.get(t.name)
    const tablePorts: ElkPort[] = []
    for (const col of visualColumnOrder(t)) {
      if (ref?.has(col.name)) {
        tablePorts.push({ id: portId(t.name, col.name, 'west'), width: 1, height: 1, layoutOptions: { 'elk.port.side': 'WEST' } })
      }
      if (col.foreignKey && col.foreignKey.table !== t.name && names.has(col.foreignKey.table)) {
        tablePorts.push({ id: portId(t.name, col.name, 'east'), width: 1, height: 1, layoutOptions: { 'elk.port.side': 'EAST' } })
      }
    }
    if (tablePorts.length) ports.set(t.name, tablePorts)
  }
  return ports
}

function portId(table: string, column: string, side: 'east' | 'west') {
  return `${table}::${column}::${side}`
}

export async function computeELKLayout(
  schema: Schema,
  measuredHeights?: Record<string, number>,
  filterTableNames?: Set<string>,
): Promise<{ positions: NodePositions }> {
  const elk = new ELK()
  const filteredSchema = filterTableNames
    ? { ...schema, tables: schema.tables.filter(t => filterTableNames.has(t.name)) }
    : schema
  const components = getComponents(filteredSchema)
  const allPositions: NodePositions = {}

  let curX = 0, curY = 0, rowH = 0

  for (const group of components) {
    const tables = filteredSchema.tables.filter(t => group.includes(t.name))
    const portsByTable = buildPorts(tables)

    const children: ElkNode[] = tables.map(t => {
      const hasTags = !!(t.tags && t.tags.length > 0)
      const h = measuredHeights?.[t.name] ?? defaultNodeHeight(t.columns.length, hasTags)
      const ports = portsByTable.get(t.name)
      return {
        id: t.name,
        width: NODE_WIDTH,
        height: h,
        ...(ports ? { ports, layoutOptions: { 'elk.portConstraints': 'FIXED_ORDER' } } : {}),
      }
    })

    const seen = new Set<string>()
    const edges: ElkExtendedEdge[] = []
    for (const t of tables) {
      for (const col of t.columns) {
        if (!col.foreignKey) continue
        const tgt = col.foreignKey.table
        if (tgt === t.name) continue
        if (!tables.find(x => x.name === tgt)) continue
        const key = `${t.name}-${tgt}-${col.name}`
        if (seen.has(key)) continue
        seen.add(key)
        edges.push({
          id: key,
          sources: [portId(t.name, col.name, 'east')],
          targets: [portId(tgt, col.foreignKey.column, 'west')],
        })
      }
    }

    const result = await elk.layout({
      id: 'root',
      layoutOptions: {
        'algorithm': 'layered',
        'elk.direction': 'RIGHT',
        'elk.edgeRouting': 'ORTHOGONAL',
        'elk.layered.spacing.nodeNodeBetweenLayers': '200',
        'elk.spacing.nodeNode': '60',
        'elk.layered.spacing.edgeNodeBetweenLayers': '40',
        'elk.spacing.edgeEdge': '20',
        'elk.layered.spacing.edgeEdgeBetweenLayers': '20',
        'elk.padding': '[top=60,left=60,bottom=60,right=60]',
        'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',
        'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF',
        'elk.layered.thoroughness': '50',
        'elk.layered.cycleBreaking.strategy': 'DEPTH_FIRST',
      },
      children,
      edges,
    })

    const compPositions: NodePositions = {}
    const nodes = result.children ?? []
    for (const node of nodes) {
      compPositions[node.id] = { x: node.x ?? 0, y: node.y ?? 0 }
    }

    if (nodes.length === 0) continue

    const nodeRects = nodes.map(n => ({
      x: n.x ?? 0,
      y: n.y ?? 0,
      w: n.width ?? NODE_WIDTH,
      h: n.height ?? 100
    }))

    const minX = Math.min(...nodeRects.map(r => r.x))
    const minY = Math.min(...nodeRects.map(r => r.y))
    const maxX = Math.max(...nodeRects.map(r => r.x + r.w))
    const maxY = Math.max(...nodeRects.map(r => r.y + r.h))
    
    const w = maxX - minX
    const h = maxY - minY

    if (curX > 0 && curX + w > ROW_WRAP) {
      curX = 0
      curY += rowH + COMP_GAP_Y
      rowH = 0
    }

    const offsetX = curX - minX
    const offsetY = curY - minY

    for (const [id, pos] of Object.entries(compPositions)) {
      allPositions[id] = { x: pos.x + offsetX, y: pos.y + offsetY }
    }
    curX += w + COMP_GAP_X
    rowH = Math.max(rowH, h)
  }

  return { positions: allPositions }
}
