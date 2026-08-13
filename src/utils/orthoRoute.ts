// Orthogonal edge routing that goes *around* table cards instead of straight
// through them.
//
// Approach is the classic orthogonal-connector one (same family as draw.io /
// libavoid): every obstacle is inflated by a clearance margin, the candidate
// turning lines are exactly the inflated obstacle borders (plus the two
// endpoints' own lines and an outer escape ring), and the route is the
// cheapest path through that sparse grid — cost being length plus a penalty
// per bend, so paths come out with as few turns as possible rather than
// staircasing.

export interface Rect { x: number; y: number; width: number; height: number }
export type Side = 'left' | 'right' | 'top' | 'bottom'
export interface Pt { x: number; y: number }

const MARGIN = 14       // clearance kept between a route and a table
const STUB = 22         // straight run out of a handle before the first turn
const TURN_COST = 60    // bend penalty in px-equivalent — keeps routes tidy
const ESCAPE = 60       // outer ring so a route can always go around everything
// obstacles far from the endpoints can't affect the route; capping keeps the
// grid small (and the search fast) on big schemas
const MAX_OBSTACLES = 40

const DIRS: Pt[] = [{ x: 1, y: 0 }, { x: -1, y: 0 }, { x: 0, y: 1 }, { x: 0, y: -1 }]

function sideDir(side: Side): Pt {
  if (side === 'left') return { x: -1, y: 0 }
  if (side === 'right') return { x: 1, y: 0 }
  if (side === 'top') return { x: 0, y: -1 }
  return { x: 0, y: 1 }
}

function dirIndex(d: Pt): number {
  return DIRS.findIndex(v => v.x === d.x && v.y === d.y)
}

// axis-aligned segment vs rect. Boundary-touching is allowed on purpose: a
// route is meant to be able to run exactly along an inflated border.
function segHitsRect(a: Pt, b: Pt, r: Rect): boolean {
  const rx2 = r.x + r.width
  const ry2 = r.y + r.height
  if (a.y === b.y) {
    if (a.y <= r.y || a.y >= ry2) return false
    const lo = Math.min(a.x, b.x)
    const hi = Math.max(a.x, b.x)
    return lo < rx2 && hi > r.x
  }
  if (a.x <= r.x || a.x >= rx2) return false
  const lo = Math.min(a.y, b.y)
  const hi = Math.max(a.y, b.y)
  return lo < ry2 && hi > r.y
}

function uniqSorted(values: number[]): number[] {
  const sorted = [...values].sort((a, b) => a - b)
  const out: number[] = []
  for (const v of sorted) {
    if (out.length === 0 || Math.abs(v - out[out.length - 1]) > 1) out.push(v)
  }
  return out
}

// minimal binary heap over [cost, state] pairs
class Heap {
  private cost: number[] = []
  private state: number[] = []
  get size() { return this.cost.length }
  push(c: number, s: number) {
    this.cost.push(c); this.state.push(s)
    let i = this.cost.length - 1
    while (i > 0) {
      const p = (i - 1) >> 1
      if (this.cost[p] <= this.cost[i]) break
      this.swap(p, i); i = p
    }
  }
  pop(): { cost: number; state: number } {
    const cost = this.cost[0]
    const state = this.state[0]
    const lastC = this.cost.pop()!
    const lastS = this.state.pop()!
    if (this.cost.length > 0) {
      this.cost[0] = lastC; this.state[0] = lastS
      let i = 0
      for (;;) {
        const l = 2 * i + 1, r = l + 1
        let m = i
        if (l < this.cost.length && this.cost[l] < this.cost[m]) m = l
        if (r < this.cost.length && this.cost[r] < this.cost[m]) m = r
        if (m === i) break
        this.swap(m, i); i = m
      }
    }
    return { cost, state }
  }
  private swap(a: number, b: number) {
    const c = this.cost[a]; this.cost[a] = this.cost[b]; this.cost[b] = c
    const s = this.state[a]; this.state[a] = this.state[b]; this.state[b] = s
  }
}

/**
 * Route from `source` (leaving via `sourceSide`) to `target` (arriving at
 * `targetSide`) without crossing any of `obstacles`. Returns the polyline
 * corner points, or null when no clear route exists (caller should fall back
 * to a direct path).
 */
export function routeOrtho(
  source: Pt,
  sourceSide: Side,
  target: Pt,
  targetSide: Side,
  obstacles: Rect[],
): Pt[] | null {
  const sDir = sideDir(sourceSide)
  const tDir = sideDir(targetSide)
  const sStub: Pt = { x: source.x + sDir.x * STUB, y: source.y + sDir.y * STUB }
  const tStub: Pt = { x: target.x + tDir.x * STUB, y: target.y + tDir.y * STUB }

  // only obstacles near the two endpoints can influence the route
  const boxX1 = Math.min(sStub.x, tStub.x) - ESCAPE * 3
  const boxX2 = Math.max(sStub.x, tStub.x) + ESCAPE * 3
  const boxY1 = Math.min(sStub.y, tStub.y) - ESCAPE * 3
  const boxY2 = Math.max(sStub.y, tStub.y) + ESCAPE * 3
  const near = obstacles
    .filter(o => o.x < boxX2 && o.x + o.width > boxX1 && o.y < boxY2 && o.y + o.height > boxY1)
    .slice(0, MAX_OBSTACLES)
    .map(o => ({ x: o.x - MARGIN, y: o.y - MARGIN, width: o.width + 2 * MARGIN, height: o.height + 2 * MARGIN }))

  const xsRaw = [sStub.x, tStub.x]
  const ysRaw = [sStub.y, tStub.y]
  for (const o of near) {
    xsRaw.push(o.x, o.x + o.width)
    ysRaw.push(o.y, o.y + o.height)
  }
  // halfway lines give a clean channel when the tables face each other
  xsRaw.push((sStub.x + tStub.x) / 2)
  ysRaw.push((sStub.y + tStub.y) / 2)
  // outer ring guarantees there is always a way around the whole cluster
  xsRaw.push(Math.min(...xsRaw) - ESCAPE, Math.max(...xsRaw) + ESCAPE)
  ysRaw.push(Math.min(...ysRaw) - ESCAPE, Math.max(...ysRaw) + ESCAPE)

  const xs = uniqSorted(xsRaw)
  const ys = uniqSorted(ysRaw)
  const nx = xs.length
  const ny = ys.length

  const ix = (v: number) => {
    let best = 0
    let bestD = Infinity
    for (let i = 0; i < nx; i++) {
      const d = Math.abs(xs[i] - v)
      if (d < bestD) { bestD = d; best = i }
    }
    return best
  }
  const iy = (v: number) => {
    let best = 0
    let bestD = Infinity
    for (let i = 0; i < ny; i++) {
      const d = Math.abs(ys[i] - v)
      if (d < bestD) { bestD = d; best = i }
    }
    return best
  }

  const sx = ix(sStub.x), sy = iy(sStub.y)
  const gx = ix(tStub.x), gy = iy(tStub.y)

  const free = (a: Pt, b: Pt) => {
    for (const o of near) if (segHitsRect(a, b, o)) return false
    return true
  }

  const stateCount = nx * ny * 4
  const dist = new Float64Array(stateCount).fill(Infinity)
  const prev = new Int32Array(stateCount).fill(-1)
  const heap = new Heap()

  const startDir = dirIndex(sDir)
  const startState = (sy * nx + sx) * 4 + startDir
  dist[startState] = 0
  heap.push(0, startState)

  // arriving at the target stub should already point into the target
  const finalDir = dirIndex({ x: -tDir.x, y: -tDir.y })
  let bestGoal = -1
  let bestGoalCost = Infinity

  while (heap.size > 0) {
    const { cost, state } = heap.pop()
    if (cost > dist[state]) continue
    const dir = state % 4
    const cell = (state - dir) / 4
    const cx = cell % nx
    const cy = (cell - cx) / nx

    if (cx === gx && cy === gy) {
      const total = cost + (dir === finalDir ? 0 : TURN_COST)
      if (total < bestGoalCost) { bestGoalCost = total; bestGoal = state }
      continue
    }

    const here: Pt = { x: xs[cx], y: ys[cy] }
    for (let nd = 0; nd < 4; nd++) {
      const d = DIRS[nd]
      const ncx = cx + d.x
      const ncy = cy + d.y
      if (ncx < 0 || ncx >= nx || ncy < 0 || ncy >= ny) continue
      const there: Pt = { x: xs[ncx], y: ys[ncy] }
      if (!free(here, there)) continue
      const step = Math.abs(there.x - here.x) + Math.abs(there.y - here.y)
      const next = cost + step + (nd === dir ? 0 : TURN_COST)
      const nState = (ncy * nx + ncx) * 4 + nd
      if (next < dist[nState]) {
        dist[nState] = next
        prev[nState] = state
        heap.push(next, nState)
      }
    }
  }

  if (bestGoal < 0) return null

  const cells: Pt[] = []
  for (let s = bestGoal; s !== -1; s = prev[s]) {
    const dir = s % 4
    const cell = (s - dir) / 4
    const cx = cell % nx
    const cy = (cell - cx) / nx
    cells.push({ x: xs[cx], y: ys[cy] })
  }
  cells.reverse()

  const pts: Pt[] = [source, ...cells, target]

  // collapse collinear/duplicate corners the grid may have introduced
  const out: Pt[] = []
  for (const p of pts) {
    const n = out.length
    if (n > 0 && Math.abs(out[n - 1].x - p.x) < 0.5 && Math.abs(out[n - 1].y - p.y) < 0.5) continue
    if (n >= 2) {
      const a = out[n - 2], b = out[n - 1]
      const collinearX = Math.abs(a.x - b.x) < 0.5 && Math.abs(b.x - p.x) < 0.5
      const collinearY = Math.abs(a.y - b.y) < 0.5 && Math.abs(b.y - p.y) < 0.5
      if (collinearX || collinearY) { out[n - 1] = p; continue }
    }
    out.push(p)
  }
  return out
}

/** Polyline -> SVG path with softly rounded corners. */
export function pointsToPath(pts: Pt[], radius = 8): string {
  if (pts.length < 2) return ''
  let d = `M ${pts[0].x},${pts[0].y}`
  for (let i = 1; i < pts.length - 1; i++) {
    const prev = pts[i - 1], cur = pts[i], next = pts[i + 1]
    const inLen = Math.abs(cur.x - prev.x) + Math.abs(cur.y - prev.y)
    const outLen = Math.abs(next.x - cur.x) + Math.abs(next.y - cur.y)
    const r = Math.min(radius, inLen / 2, outLen / 2)
    if (r < 0.5) { d += ` L ${cur.x},${cur.y}`; continue }
    const inDir = { x: Math.sign(cur.x - prev.x), y: Math.sign(cur.y - prev.y) }
    const outDir = { x: Math.sign(next.x - cur.x), y: Math.sign(next.y - cur.y) }
    d += ` L ${cur.x - inDir.x * r},${cur.y - inDir.y * r}`
    d += ` Q ${cur.x},${cur.y} ${cur.x + outDir.x * r},${cur.y + outDir.y * r}`
  }
  const last = pts[pts.length - 1]
  return `${d} L ${last.x},${last.y}`
}

/** Point halfway along a polyline — used to place the edge's hover label. */
export function pathMidpoint(pts: Pt[]): Pt {
  let total = 0
  for (let i = 1; i < pts.length; i++) {
    total += Math.abs(pts[i].x - pts[i - 1].x) + Math.abs(pts[i].y - pts[i - 1].y)
  }
  let walked = 0
  const half = total / 2
  for (let i = 1; i < pts.length; i++) {
    const len = Math.abs(pts[i].x - pts[i - 1].x) + Math.abs(pts[i].y - pts[i - 1].y)
    if (walked + len >= half) {
      const t = len === 0 ? 0 : (half - walked) / len
      return {
        x: pts[i - 1].x + (pts[i].x - pts[i - 1].x) * t,
        y: pts[i - 1].y + (pts[i].y - pts[i - 1].y) * t,
      }
    }
    walked += len
  }
  return pts[pts.length - 1]
}
