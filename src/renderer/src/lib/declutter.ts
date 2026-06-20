// declutter.ts
//
// Declutter — Layout-Preserving Overlap Resolver.
//
// A PURE, deterministic force-directed micro-reflow. Unlike arrange()/flowLayout()
// (which blindly re-grid EVERY node and reset the camera), this nudges apart ONLY
// the nodes whose rectangles actually overlap, leaving every non-overlapping node
// exactly where it is. The camera never moves; the caller (canvas.declutter) only
// applies the small position deltas this returns.
//
// This module imports NOTHING (plain data in / plain data out — the same zero-cycle,
// build-safe contract as lib/pipelineWalk.ts / lib/thermal.ts), so it runs under
// `node --test` with a TS loader and is trivially unit-testable.

/** A node rectangle in world space. Only id + box are needed (kind-agnostic). */
export interface Box {
  id: string
  x: number
  y: number
  w: number
  h: number
}

export interface ResolveOpts {
  /** Minimum empty gutter to leave between two separated boxes. Default 16. */
  gap?: number
  /** Hard cap on relaxation passes (deterministic bail). Default 40. */
  iterations?: number
  /**
   * Optional ANCHOR id (typically the selectedId): the focused node never moves,
   * so overlapping neighbors are pushed fully off it rather than splitting the
   * push. This keeps the node you're looking at spatially pinned.
   */
  anchorId?: string | null
}

/** True when two rectangles overlap (strictly, before the gap is considered). */
function overlaps(a: Box, b: Box): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
}

/**
 * Iterative pairwise box-overlap relaxation. For every overlapping pair we compute
 * the axis-aligned minimum-translation-vector (the CHEAPER of the x-overlap vs the
 * y-overlap, plus the gap) and split the separation half to each box — UNLESS one
 * of the pair is the anchor, in which case the other box takes the full push and
 * the anchor stays put. Repeats until a pass produces zero overlaps or the
 * iteration cap is hit. No randomness, no camera, no IPC.
 *
 * Returns a Map of ONLY the ids whose final position actually changed (beyond a
 * sub-pixel epsilon), each to its new rounded {x,y}. An empty Map means nothing
 * overlapped, so the caller can no-op (zero cost when the layout is already clean).
 */
export function resolveOverlaps(
  input: Box[],
  opts: ResolveOpts = {}
): Map<string, { x: number; y: number }> {
  const gap = opts.gap ?? 16
  const maxIter = opts.iterations ?? 40
  const anchorId = opts.anchorId ?? null

  // Work on mutable copies so the caller's array is never touched.
  const boxes = input.map((b) => ({ ...b }))
  // Stable index for deterministic tie-breaking of the push direction.
  const indexOf = new Map<string, number>()
  boxes.forEach((b, i) => indexOf.set(b.id, i))

  for (let iter = 0; iter < maxIter; iter++) {
    let moved = false
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i]
        const b = boxes[j]
        if (!overlaps(a, b)) continue

        const acx = a.x + a.w / 2
        const acy = a.y + a.h / 2
        const bcx = b.x + b.w / 2
        const bcy = b.y + b.h / 2

        // Penetration depth on each axis (positive while overlapping). Add the gap
        // so separated boxes end up with a real gutter between them, not flush.
        const overlapX = (a.w + b.w) / 2 - Math.abs(acx - bcx) + gap
        const overlapY = (a.h + b.h) / 2 - Math.abs(acy - bcy) + gap

        // Separate along the CHEAPER axis (smaller minimum translation).
        if (overlapX < overlapY) {
          // Push apart horizontally. Deterministic direction: lower center-x goes
          // left; on an exact tie, the lower stable index goes left.
          const dir = acx < bcx ? -1 : acx > bcx ? 1 : indexOf.get(a.id)! < indexOf.get(b.id)! ? -1 : 1
          const aAnchored = a.id === anchorId
          const bAnchored = b.id === anchorId
          if (aAnchored && bAnchored) continue // both pinned — cannot resolve here
          if (aAnchored) {
            b.x += -dir * overlapX
          } else if (bAnchored) {
            a.x += dir * overlapX
          } else {
            a.x += dir * (overlapX / 2)
            b.x += -dir * (overlapX / 2)
          }
        } else {
          const dir = acy < bcy ? -1 : acy > bcy ? 1 : indexOf.get(a.id)! < indexOf.get(b.id)! ? -1 : 1
          const aAnchored = a.id === anchorId
          const bAnchored = b.id === anchorId
          if (aAnchored && bAnchored) continue
          if (aAnchored) {
            b.y += -dir * overlapY
          } else if (bAnchored) {
            a.y += dir * overlapY
          } else {
            a.y += dir * (overlapY / 2)
            b.y += -dir * (overlapY / 2)
          }
        }
        moved = true
      }
    }
    if (!moved) break // converged: a whole pass with no overlaps
  }

  // Emit only the boxes whose position meaningfully changed.
  const out = new Map<string, { x: number; y: number }>()
  for (const b of boxes) {
    const orig = input[indexOf.get(b.id)!]
    const nx = Math.round(b.x)
    const ny = Math.round(b.y)
    if (Math.abs(nx - orig.x) >= 1 || Math.abs(ny - orig.y) >= 1) {
      out.set(b.id, { x: nx, y: ny })
    }
  }
  return out
}
