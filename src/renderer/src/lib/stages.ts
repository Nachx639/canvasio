// stages.ts
//
// Stages — Curated Multi-Node Scenes. A Stage is a named, persisted SET of node
// ids ("the 3 agents building the API"). Activating one frames the camera over
// the collective bounding box of exactly those nodes and spotlights that subset
// (dimming the rest) via the SAME .spotlit/.dimmed chrome the Constellation
// Filter already drives — the difference is the set is named and durable instead
// of derived from a live query.
//
// This module is PURE DATA + PURE GEOMETRY helpers only. It imports ONLY the
// CanvasNode type from canvas.ts (erased at build time), so canvas.ts may import
// it back at runtime without any cycle (mirroring history.ts's type-only import
// discipline). The Stage list itself lives on the canvas store (beside
// `waypoints`) to reuse its exact persistence wiring; these helpers do the
// geometry (boundsOf) and the sanitize/prune the store + loadLayout call.

import type { CanvasNode } from '../store/canvas'

/** A curated, named set of node ids. PURE DATA — persisted into canvasio:layout
 *  exactly like Waypoints/Regions. Stores NO geometry: the box is computed live
 *  from the referenced nodes on activation, so it can never desync. */
export interface Stage {
  id: string
  name: string
  nodeIds: string[]
}

/** Max saved Stages, so ⌘⇧1..9 always map to a slot (mirrors MAX_WAYPOINTS). */
export const MAX_STAGES = 9

/**
 * Union the world-space bounding boxes of the nodes whose ids are in `ids`.
 * Read-only over `nodes`: it NEVER mutates node coordinates. Returns null when
 * none of the ids resolve to a present node (so the caller never frames an empty
 * box / produces a NaN camera). This is the same box-union math frameMatches()
 * runs for the Constellation Filter, lifted into one shared place.
 */
export function boundsOf(
  nodes: CanvasNode[],
  ids: Iterable<string>
): { minX: number; minY: number; maxX: number; maxY: number } | null {
  const want = ids instanceof Set ? ids : new Set(ids)
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  let any = false
  for (const n of nodes) {
    if (!want.has(n.id)) continue
    minX = Math.min(minX, n.x)
    minY = Math.min(minY, n.y)
    maxX = Math.max(maxX, n.x + n.w)
    maxY = Math.max(maxY, n.y + n.h)
    any = true
  }
  if (!any) return null
  return { minX, minY, maxX, maxY }
}

/**
 * Prune a Stage's nodeIds down to the ids still present in `present` (a set of
 * live node ids), preserving order and dropping duplicates. Used both when
 * activating a Stage (so a spotlight never references a closed node) and in the
 * node-close/reset reducers (so a saved Stage drops stale ids).
 */
export function pruneStageIds(nodeIds: string[], present: Set<string>): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const id of nodeIds) {
    if (!present.has(id) || seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  return out
}

/**
 * Sanitize a raw (possibly hand-edited / imported) Stage list into safe Stages,
 * pruning each Stage's nodeIds to the live `present` ids, dropping Stages that
 * end up empty, de-duping ids, enforcing a usable id/name, and capping at
 * MAX_STAGES. Mirrors the Waypoint/Region restore discipline so a malformed
 * canvasio:layout can never inject a bad Stage. `present` is the set of node ids that
 * survived the same load, so a Stage can never point at a now-gone node.
 */
export function sanitizeStages(raw: unknown, present: Set<string>): Stage[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const out: Stage[] = []
  for (const s of raw) {
    if (!s || typeof s !== 'object') continue
    const o = s as Partial<Stage>
    if (!Array.isArray(o.nodeIds)) continue
    const nodeIds = pruneStageIds(
      o.nodeIds.filter((x): x is string => typeof x === 'string'),
      present
    )
    if (!nodeIds.length) continue // a Stage with no live members is meaningless
    const id = o.id && typeof o.id === 'string' && !seen.has(o.id) ? o.id : ''
    const finalId = id || `stage-${out.length}-${Math.random().toString(36).slice(2, 8)}`
    seen.add(finalId)
    out.push({
      id: finalId,
      name: (typeof o.name === 'string' && o.name.trim()) || `Escena ${out.length + 1}`,
      nodeIds
    })
    if (out.length >= MAX_STAGES) break
  }
  return out
}
