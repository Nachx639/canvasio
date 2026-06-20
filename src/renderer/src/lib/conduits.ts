// conduits.ts
//
// Relay Conduits — PURE handoff-graph geometry. NO DOM, NO stores, NO IPC: every
// function takes plain data (node boxes + relay edges) and returns plain data, so
// it is trivially unit-testable (see conduits.test.ts) and reusable by both the
// in-world ConduitsLayer and the Minimap (the SAME computeConduits feeds both).
//
// The Agent Relay already encodes "who hands off to whom" as sourceId -> targetId
// rules, and flowLayout() arranges nodes BY that graph — yet the connections were
// never drawn. computeConduits() turns each rule (whose endpoints still exist on
// the canvas) into a drawable edge: a line from the SOURCE node's border to the
// TARGET node's border (clamped to box edges, not centers), plus a cubic-bezier
// path + an arrowhead at the target, color-coded by the source agent kind.
//
// Purity contract mirrors territory.ts / criticalPath.ts: types-only imports, all
// deterministic, precision-over-recall (skip self-edges, dedup parallels, drop any
// edge missing an endpoint).

import type { AgentKind } from '../store/canvas'

/** The minimal node shape conduit math needs (a subset of CanvasNode). */
export interface ConduitNode {
  id: string
  x: number
  y: number
  w: number
  h: number
  /** terminal agents carry a persona; used purely for edge color. */
  agent?: AgentKind
}

/** The minimal relay-rule shape conduit math needs (a subset of RelayRule). */
export interface ConduitRule {
  sourceId: string
  targetId: string
}

/** A single drawable handoff edge between two node borders. */
export interface Conduit {
  /** stable id `${sourceId}->${targetId}` (dedup key for parallel edges). */
  id: string
  sourceId: string
  targetId: string
  /** source border anchor (world coords). */
  x1: number
  y1: number
  /** target border anchor (world coords). */
  x2: number
  y2: number
  /** the source agent kind (drives edge color), or undefined for non-agents. */
  kind?: AgentKind
}

/** The center point of a node box. */
function center(n: ConduitNode): { cx: number; cy: number } {
  return { cx: n.x + n.w / 2, cy: n.y + n.h / 2 }
}

/**
 * Clamp the segment from a node's CENTER toward an external target point to the
 * node's rectangular border, so the line touches the box EDGE (not its center).
 * Standard center->point ray vs. axis-aligned-rect intersection: scale the
 * direction by the smaller of the half-width/|dx| and half-height/|dy| ratios.
 * A degenerate zero-length direction returns the center unchanged.
 */
export function borderAnchor(
  node: ConduitNode,
  toward: { x: number; y: number }
): { x: number; y: number } {
  const { cx, cy } = center(node)
  const dx = toward.x - cx
  const dy = toward.y - cy
  if (dx === 0 && dy === 0) return { x: cx, y: cy }
  const hw = node.w / 2
  const hh = node.h / 2
  // How far along the ray (as a fraction of the direction) until we hit each axis
  // border; the first border hit (the smaller scale) is where the ray exits.
  const sx = dx !== 0 ? hw / Math.abs(dx) : Infinity
  const sy = dy !== 0 ? hh / Math.abs(dy) : Infinity
  const s = Math.min(sx, sy)
  return { x: cx + dx * s, y: cy + dy * s }
}

/**
 * Compute every drawable conduit for the current relay graph. For each rule whose
 * BOTH endpoints still exist among `nodes`, emit one edge from the source border
 * (aimed at the target center) to the target border (aimed at the source center).
 * Self-edges (sourceId === targetId) are skipped; parallel duplicates (same
 * source+target) are deduped, keeping the first. Order follows the input rules
 * (deterministic). Pure — no DOM/store/IPC.
 */
export function computeConduits(nodes: ConduitNode[], rules: ConduitRule[]): Conduit[] {
  const byId = new Map(nodes.map((n) => [n.id, n] as const))
  const seen = new Set<string>()
  const out: Conduit[] = []
  for (const r of rules) {
    if (r.sourceId === r.targetId) continue
    const src = byId.get(r.sourceId)
    const dst = byId.get(r.targetId)
    if (!src || !dst) continue
    const id = `${r.sourceId}->${r.targetId}`
    if (seen.has(id)) continue
    seen.add(id)
    const sc = center(src)
    const dc = center(dst)
    const a = borderAnchor(src, { x: dc.cx, y: dc.cy })
    const b = borderAnchor(dst, { x: sc.cx, y: sc.cy })
    out.push({
      id,
      sourceId: r.sourceId,
      targetId: r.targetId,
      x1: a.x,
      y1: a.y,
      x2: b.x,
      y2: b.y,
      kind: src.agent
    })
  }
  return out
}

/**
 * A gentle cubic-bezier control-point pair for an edge, bowing the path slightly
 * perpendicular to the straight line so parallel/crossing conduits read as
 * distinct arcs rather than overlapping straight segments. The bow magnitude
 * scales with the segment length (capped) and is independent of camera/zoom (the
 * whole layer is drawn in world space and inherits the camera transform). Pure.
 */
export function bezierControls(
  c: Conduit
): { c1x: number; c1y: number; c2x: number; c2y: number } {
  const dx = c.x2 - c.x1
  const dy = c.y2 - c.y1
  const len = Math.hypot(dx, dy) || 1
  // Unit perpendicular to the segment.
  const px = -dy / len
  const py = dx / len
  // Bow ~12% of length, capped so long edges don't balloon. Deterministic sign
  // (always bows the same way) so an edge's curve is stable frame-to-frame.
  const bow = Math.min(80, len * 0.12)
  const mx = (c.x1 + c.x2) / 2
  const my = (c.y1 + c.y2) / 2
  return {
    c1x: c.x1 + dx / 3 + px * bow,
    c1y: c.y1 + dy / 3 + py * bow,
    c2x: c.x2 - dx / 3 + px * bow,
    c2y: c.y2 - dy / 3 + py * bow
  }
}

/** The SVG cubic-bezier path `d` string for a conduit (M …, C …). Pure. */
export function conduitPath(c: Conduit): string {
  const { c1x, c1y, c2x, c2y } = bezierControls(c)
  return `M ${c.x1} ${c.y1} C ${c1x} ${c1y} ${c2x} ${c2y} ${c.x2} ${c.y2}`
}

/**
 * The three points of a small filled arrowhead at the target end (x2,y2),
 * pointing along the incoming bezier (its tangent at t=1 is from c2 -> end). Size
 * is in world px (constant on the canvas; it scales with zoom like everything in
 * world space). Returns an SVG points string "x,y x,y x,y". Pure.
 */
export function arrowHead(c: Conduit, size = 11): string {
  const { c2x, c2y } = bezierControls(c)
  // Incoming direction = end minus the last control point (bezier tangent at t=1).
  let ax = c.x2 - c2x
  let ay = c.y2 - c2y
  const len = Math.hypot(ax, ay) || 1
  ax /= len
  ay /= len
  // Two base corners, splayed ±~25° behind the tip.
  const spread = 0.45 // ~25.7°
  const bx = c.x2 - ax * size
  const by = c.y2 - ay * size
  // perpendicular
  const px = -ay
  const py = ax
  const half = size * spread
  const p1x = bx + px * half
  const p1y = by + py * half
  const p2x = bx - px * half
  const p2y = by - py * half
  return `${c.x2},${c.y2} ${p1x},${p1y} ${p2x},${p2y}`
}
