// territory.ts
//
// Districts — pure geometry + auto-clustering helpers. NO DOM, NO stores, NO IPC:
// every function takes plain data and returns plain data, so they are trivially
// unit-testable (see territory.test.ts) and reusable by the RegionsLayer, the
// Minimap, the CommandPalette ("Fly to <name>" + "Map my territory"), and any
// camera framing.

import type { Region } from '../store/regions'
import { DISTRICT_COLORS } from '../store/regions'

/** The minimal node shape territory math needs (a subset of CanvasNode). */
export interface NodeBox {
  id: string
  x: number
  y: number
  w: number
  h: number
}

/** A single relay edge (subset of RelayRule): a handoff source -> target. */
export interface RelayEdge {
  sourceId: string
  targetId: string
}

/** Padding (world px) added around a clustered node group's bounds. */
const CLUSTER_PAD = 36

/** The center point of a node box. */
function center(n: NodeBox): { cx: number; cy: number } {
  return { cx: n.x + n.w / 2, cy: n.y + n.h / 2 }
}

/**
 * Every node whose CENTER falls inside the region rectangle. Center-based (not
 * full-overlap) so a node straddling an edge is unambiguously owned by exactly
 * one District — the containment-drag and Minimap tinting then agree. Read-only.
 */
export function nodesInRegion<T extends NodeBox>(region: Region, nodes: T[]): T[] {
  const x0 = region.x
  const y0 = region.y
  const x1 = region.x + region.w
  const y1 = region.y + region.h
  return nodes.filter((n) => {
    const { cx, cy } = center(n)
    return cx >= x0 && cx <= x1 && cy >= y0 && cy <= y1
  })
}

/** The region's framing box for camera centering (a plain {x,y,w,h}). */
export function regionBounds(region: Region): { x: number; y: number; w: number; h: number } {
  return { x: region.x, y: region.y, w: region.w, h: region.h }
}

/** The axis-aligned bounding box of a set of node boxes, or null if empty. */
function boundsOf(nodes: NodeBox[]): { x: number; y: number; w: number; h: number } | null {
  if (!nodes.length) return null
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const n of nodes) {
    minX = Math.min(minX, n.x)
    minY = Math.min(minY, n.y)
    maxX = Math.max(maxX, n.x + n.w)
    maxY = Math.max(maxY, n.y + n.h)
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
}

/**
 * Group node ids into connected components of the relay graph (undirected: a
 * handoff in either direction links two nodes into the same pipeline). Nodes not
 * referenced by any edge are NOT included here — they fall through to spatial
 * clustering in suggestDistricts. Pure union-find over edges restricted to the
 * given node set.
 */
function relayComponents(nodes: NodeBox[], edges: RelayEdge[]): string[][] {
  const ids = new Set(nodes.map((n) => n.id))
  const parent = new Map<string, string>()
  const find = (a: string): string => {
    let r = a
    while (parent.get(r) !== r) r = parent.get(r)!
    // path-compress
    let c = a
    while (parent.get(c) !== r) {
      const next = parent.get(c)!
      parent.set(c, r)
      c = next
    }
    return r
  }
  const union = (a: string, b: string): void => {
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) parent.set(ra, rb)
  }
  for (const e of edges) {
    if (!ids.has(e.sourceId) || !ids.has(e.targetId)) continue
    if (!parent.has(e.sourceId)) parent.set(e.sourceId, e.sourceId)
    if (!parent.has(e.targetId)) parent.set(e.targetId, e.targetId)
    union(e.sourceId, e.targetId)
  }
  const groups = new Map<string, string[]>()
  for (const id of parent.keys()) {
    const root = find(id)
    const g = groups.get(root) ?? []
    g.push(id)
    groups.set(root, g)
  }
  // Only components with 2+ nodes form a meaningful pipeline District.
  return [...groups.values()].filter((g) => g.length >= 2)
}

/**
 * Cluster the leftover (un-wired) nodes by spatial proximity using the SAME
 * (y,x) reading-order arrange()/flowLayout() already trust: sort top-to-bottom
 * then left-to-right, and start a new band whenever the vertical gap to the
 * previous node's row exceeds a threshold derived from typical node heights.
 * This produces "rows of work" that read naturally as Districts. Pure.
 */
function spatialBands(nodes: NodeBox[]): string[][] {
  if (!nodes.length) return []
  const ordered = [...nodes].sort((a, b) => a.y - b.y || a.x - b.x)
  // Band threshold: half the median node height (falls back to 200px). A node
  // whose TOP sits more than this below the current band's baseline starts a new
  // band, so stacked rows split while a jittered single row stays together.
  const heights = ordered.map((n) => n.h).sort((a, b) => a - b)
  const medianH = heights[Math.floor(heights.length / 2)] || 360
  const gap = Math.max(120, medianH * 0.6)
  const bands: string[][] = []
  let band: NodeBox[] = []
  let baseline = ordered[0].y
  for (const n of ordered) {
    if (band.length && n.y - baseline > gap) {
      bands.push(band.map((b) => b.id))
      band = []
      baseline = n.y
    }
    if (!band.length) baseline = n.y
    band.push(n)
  }
  if (band.length) bands.push(band.map((b) => b.id))
  return bands.filter((b) => b.length >= 1)
}

/**
 * "Map my territory" — propose Districts for the given nodes by REUSING the
 * existing spatial + relay shapes (no new layout algorithm):
 *   1. Relay-connected pipelines become one District each (a handoff chain is a
 *      semantic unit — "Frontend pipeline").
 *   2. Every remaining un-wired node is clustered into reading-order spatial
 *      bands ("rows of work"), one District per band.
 * Each District is the padded bounding box of its group's nodes, named generically
 * ("Distrito 1", "Distrito 2"…) for the user to rename, and colored from the
 * palette. Returns [] for fewer than 2 nodes (nothing to organize). Pure.
 */
export function suggestDistricts(nodes: NodeBox[], edges: RelayEdge[]): Region[] {
  if (nodes.length < 2) return []
  const byId = new Map(nodes.map((n) => [n.id, n] as const))
  const claimed = new Set<string>()
  const groups: string[][] = []

  // (1) relay pipelines first
  for (const comp of relayComponents(nodes, edges)) {
    groups.push(comp)
    for (const id of comp) claimed.add(id)
  }

  // (2) spatial bands over the leftovers
  const leftover = nodes.filter((n) => !claimed.has(n.id))
  for (const band of spatialBands(leftover)) groups.push(band)

  // Materialize each group as a padded-bbox Region.
  const regions: Region[] = []
  groups.forEach((ids, i) => {
    const members = ids.map((id) => byId.get(id)).filter((n): n is NodeBox => !!n)
    const bb = boundsOf(members)
    if (!bb) return
    regions.push({
      id: `district-${i}-${Math.random().toString(36).slice(2, 8)}`,
      name: `Distrito ${i + 1}`,
      x: Math.round(bb.x - CLUSTER_PAD),
      y: Math.round(bb.y - CLUSTER_PAD),
      w: Math.round(bb.w + CLUSTER_PAD * 2),
      h: Math.round(bb.h + CLUSTER_PAD * 2),
      color: DISTRICT_COLORS[i % DISTRICT_COLORS.length]
    })
  })
  return regions
}
