/**
 * Pure layout engine for the voice-brain `draw_diagram` action. Given a list of
 * labelled nodes and the edges (connectivity) between them, it computes
 * world-space boxes (x, y, w, h sized to the label text) laid out as a readable
 * top-down flow inside the CURRENTLY VISIBLE viewport, plus the edge list for the
 * caller to draw arrows. Boxes within a layer are spread horizontally and never
 * overlap; layers stack vertically with a fixed gap.
 *
 * Deterministic and side-effect-free: it takes a `visibleRect` snapshot (computed
 * by the caller from getState()) and never reads zustand directly, so the React
 * #185 new-ref-selector pitfall does not apply. No imports beyond the `Box` type.
 */

import type { Box } from './drawPlacement'

/** One diagram node; (x,y,w,h) are filled in by layoutDiagram. */
export interface DiagramNode {
  id: string
  label: string
  x: number
  y: number
  w: number
  h: number
}

/** A directed edge between two node ids. */
export interface DiagramEdge {
  from: string
  to: string
}

/** Result of laying out a diagram: positioned nodes (by id) + the edges. */
export interface DiagramLayout {
  nodes: Map<string, DiagramNode>
  edges: DiagramEdge[]
}

/** Box-size bounds (world px). Boxes are sized to their label, then clamped. */
const MIN_W = 120
const MAX_W = 300
const BOX_H = 72
/** Per-character width + horizontal padding used by the text heuristic. */
const CHAR_W = 8.5
const PAD_X = 28
/** Gaps between layers (vertical) and between boxes within a layer (horizontal). */
const LAYER_GAP = 64
const COL_GAP = 36

/**
 * Heuristic box size for a label: width grows with character count (clamped to
 * MIN_W..MAX_W), height is a fixed readable row. A real text-measure function can
 * be injected by the caller; the heuristic keeps the function pure + deterministic
 * when none is supplied.
 */
function sizeFor(
  label: string,
  measure?: (text: string) => { width: number; height: number }
): { w: number; h: number } {
  if (measure) {
    try {
      const m = measure(label)
      const w = Math.min(MAX_W, Math.max(MIN_W, Math.round(m.width + PAD_X)))
      const h = Math.max(BOX_H, Math.round(m.height + 24))
      return { w, h }
    } catch {
      /* fall through to heuristic */
    }
  }
  const w = Math.min(MAX_W, Math.max(MIN_W, Math.round(label.length * CHAR_W + PAD_X)))
  return { w, h: BOX_H }
}

/**
 * Assign each node a layer (depth) via Kahn's topological sort over the edge
 * graph. Nodes with no resolved incoming edge start at layer 0; each edge pushes
 * its target at least one layer below its source. Cycles (or edges referencing
 * unknown ids) are tolerated: any node never assigned a layer by the queue is
 * folded into a trailing layer so it is always placed. Returns layer index per id.
 */
function assignLayers(ids: string[], edges: DiagramEdge[]): Map<string, number> {
  const idSet = new Set(ids)
  const valid = edges.filter((e) => idSet.has(e.from) && idSet.has(e.to) && e.from !== e.to)
  const indeg = new Map<string, number>()
  const out = new Map<string, string[]>()
  for (const id of ids) {
    indeg.set(id, 0)
    out.set(id, [])
  }
  for (const e of valid) {
    indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1)
    out.get(e.from)!.push(e.to)
  }
  const layer = new Map<string, number>()
  // Seed the queue with all roots (indeg 0), preserving input order.
  let frontier = ids.filter((id) => (indeg.get(id) ?? 0) === 0)
  for (const id of frontier) layer.set(id, 0)
  const work = new Map(indeg)
  while (frontier.length) {
    const next: string[] = []
    for (const id of frontier) {
      const d = layer.get(id) ?? 0
      for (const to of out.get(id) ?? []) {
        work.set(to, (work.get(to) ?? 0) - 1)
        const cand = d + 1
        if ((layer.get(to) ?? -1) < cand) layer.set(to, cand)
        if ((work.get(to) ?? 0) <= 0 && !next.includes(to)) next.push(to)
      }
    }
    frontier = next.filter((id) => layer.has(id))
  }
  // Any id left unplaced (pure cycle / disconnected) → drop it after the deepest
  // assigned layer so it still gets a slot and the caller can draw it.
  let maxLayer = 0
  for (const v of layer.values()) maxLayer = Math.max(maxLayer, v)
  for (const id of ids) {
    if (!layer.has(id)) layer.set(id, maxLayer + 1)
  }
  return layer
}

/**
 * Lay out a flow diagram (top-down) into the visible viewport.
 *
 * Strategy:
 *   - Measure each label → box size (heuristic or injected measurer).
 *   - Topologically layer the nodes (Kahn); each layer is one horizontal row.
 *   - Stack layers vertically (row height = tallest box in the layer + LAYER_GAP).
 *   - Within a layer, lay boxes left→right with COL_GAP between them, centring the
 *     whole row horizontally on the visible rect.
 *   - Shift the entire diagram so its top sits a little below the viewport top,
 *     and horizontally centre it. If the diagram is wider/taller than the visible
 *     rect it simply overflows from the top-left anchor (the caller can fit/zoom).
 *
 * Pure: no zustand reads, no I/O. Same input → same output.
 */
export function layoutDiagram(
  rawNodes: Array<{ id: string; label: string }>,
  rawEdges: Array<[string, string]>,
  visibleRect: Box,
  textMeasure?: (text: string) => { width: number; height: number }
): DiagramLayout {
  const ids = rawNodes.map((n) => n.id)
  const edges: DiagramEdge[] = rawEdges.map(([from, to]) => ({ from, to }))

  // Size every node up front.
  const sized = new Map<string, DiagramNode>()
  for (const n of rawNodes) {
    const { w, h } = sizeFor(n.label, textMeasure)
    sized.set(n.id, { id: n.id, label: n.label, x: 0, y: 0, w, h })
  }

  // Layer the graph and bucket node ids per layer (input order within a layer).
  const layerOf = assignLayers(ids, edges)
  const buckets: string[][] = []
  for (const id of ids) {
    const L = layerOf.get(id) ?? 0
    ;(buckets[L] ||= []).push(id)
  }

  // Compute each layer's row metrics (total width, max height).
  let maxRowW = 0
  const rowHeights: number[] = []
  for (let L = 0; L < buckets.length; L++) {
    const row = buckets[L] ?? []
    let rowW = 0
    let rowH = 0
    for (const id of row) {
      const node = sized.get(id)!
      rowW += node.w
      rowH = Math.max(rowH, node.h)
    }
    if (row.length > 1) rowW += COL_GAP * (row.length - 1)
    maxRowW = Math.max(maxRowW, rowW)
    rowHeights[L] = rowH || BOX_H
  }

  // Anchor: centre the widest row on the visible rect; start near the top.
  const startY = visibleRect.y + Math.min(40, visibleRect.h * 0.06)
  const centreX = visibleRect.x + visibleRect.w / 2

  let cursorY = startY
  for (let L = 0; L < buckets.length; L++) {
    const row = buckets[L] ?? []
    if (!row.length) continue
    // Total width of this row to centre it horizontally.
    let rowW = 0
    for (const id of row) rowW += sized.get(id)!.w
    if (row.length > 1) rowW += COL_GAP * (row.length - 1)
    let cursorX = centreX - rowW / 2
    const rowH = rowHeights[L]
    for (const id of row) {
      const node = sized.get(id)!
      node.x = Math.round(cursorX)
      // Vertically centre each box within the layer row band.
      node.y = Math.round(cursorY + (rowH - node.h) / 2)
      cursorX += node.w + COL_GAP
    }
    cursorY += rowH + LAYER_GAP
  }

  return { nodes: sized, edges }
}
