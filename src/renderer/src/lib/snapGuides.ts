// snapGuides.ts
//
// Magnetic Align — Smart Snap Guides for window dragging.
//
// A PURE geometry helper: given the box currently being dragged plus the boxes of
// every other node, it returns the smallest in-threshold correction (independently
// on X and Y) that snaps the moving box's edges/centers onto a nearby node's
// edges/centers, together with the world-space guide segments to draw.
//
// Like declutter.ts / pipelineWalk.ts / thermal.ts this module imports NOTHING
// (plain data in / plain data out — same zero-cycle, build-safe contract), so it
// is trivially unit-testable under `node --test` and can never introduce an import
// cycle into the renderer. No DOM, no stores, no IPC, no persistence.

/** A node rectangle in world space. */
export interface SnapBox {
  x: number
  y: number
  w: number
  h: number
}

/** A guide line to draw, in WORLD space. Either vertical (x set) or horizontal (y set). */
export interface GuideLine {
  /** 'v' = vertical line at world x; 'h' = horizontal line at world y. */
  axis: 'v' | 'h'
  /** world coordinate of the line on its perpendicular axis. */
  pos: number
  /** the segment span along the line's own axis (so it spans both boxes' union). */
  from: number
  to: number
}

export interface SnapResult {
  /** correction to ADD to the moving box's x (0 when nothing snapped on X). */
  dx: number
  /** correction to ADD to the moving box's y (0 when nothing snapped on Y). */
  dy: number
  /** world-space guide segments for whatever snapped (empty when nothing snapped). */
  guides: GuideLine[]
}

export interface SnapOpts {
  /** current camera zoom — used to keep the snap feel zoom-invariant. */
  zoom: number
  /**
   * snap tolerance in SCREEN pixels (divided by zoom internally so the world-space
   * threshold shrinks as you zoom in, keeping the felt magnetism constant). Default 6.
   */
  threshold?: number
  /**
   * Alt-held bypass: when true, snapping is fully suspended (identity result) so
   * the user can place freely. Lets the caller funnel everything through one call.
   */
  bypass?: boolean
}

const IDENTITY: SnapResult = { dx: 0, dy: 0, guides: [] }

/** The three reference coordinates of a box on the X axis: left, center, right. */
function xRefs(b: SnapBox): number[] {
  return [b.x, b.x + b.w / 2, b.x + b.w]
}
/** The three reference coordinates of a box on the Y axis: top, center, bottom. */
function yRefs(b: SnapBox): number[] {
  return [b.y, b.y + b.h / 2, b.y + b.h]
}

interface AxisPick {
  /** signed correction to add to the moving box on this axis. */
  delta: number
  /** world coordinate the line sits at (the matched target coordinate). */
  pos: number
  /** the index of the `others` box we snapped to (for span computation). */
  other: SnapBox
}

/**
 * For one axis, find the closest (smallest-|delta|) reference-to-reference match
 * within `tol`. `movingRefs` are the moving box's three refs at its CURRENT raw
 * position; `targetRefsOf` extracts the three refs from a candidate box. Returns
 * null when nothing is within tolerance.
 */
function bestAxisSnap(
  movingRefs: number[],
  others: SnapBox[],
  refsOf: (b: SnapBox) => number[],
  tol: number
): AxisPick | null {
  let best: AxisPick | null = null
  for (const o of others) {
    const targetRefs = refsOf(o)
    for (const m of movingRefs) {
      for (const t of targetRefs) {
        const diff = t - m
        if (Math.abs(diff) > tol) continue
        if (best === null || Math.abs(diff) < Math.abs(best.delta)) {
          best = { delta: diff, pos: t, other: o }
        }
      }
    }
  }
  return best
}

/**
 * Compute the magnetic-snap correction for a dragged box against its neighbors.
 *
 * X and Y are solved INDEPENDENTLY: each axis snaps to the nearest in-threshold
 * edge/center alignment, or stays free. The returned dx/dy are deltas the caller
 * ADDS to the box's raw position. Guide segments are emitted in world space and
 * span the union of the moving box (post-correction) and the matched neighbor on
 * the line's own axis, so the flashed line visibly connects the two aligned boxes.
 */
export function computeSnap(moving: SnapBox, others: SnapBox[], opts: SnapOpts): SnapResult {
  if (opts.bypass) return IDENTITY
  const zoom = opts.zoom > 0 ? opts.zoom : 1
  // Screen-pixel tolerance → world units (zoom-invariant felt magnetism).
  const tol = (opts.threshold ?? 6) / zoom
  if (others.length === 0 || tol <= 0) return IDENTITY

  const xPick = bestAxisSnap(xRefs(moving), others, xRefs, tol)
  const yPick = bestAxisSnap(yRefs(moving), others, yRefs, tol)

  const dx = xPick ? xPick.delta : 0
  const dy = yPick ? yPick.delta : 0
  if (xPick === null && yPick === null) return IDENTITY

  // The corrected moving box (used to span the guide segments).
  const snapped: SnapBox = { x: moving.x + dx, y: moving.y + dy, w: moving.w, h: moving.h }
  const guides: GuideLine[] = []

  if (xPick) {
    // Vertical guide at the matched x; spans the vertical union of both boxes.
    const o = xPick.other
    guides.push({
      axis: 'v',
      pos: xPick.pos,
      from: Math.min(snapped.y, o.y),
      to: Math.max(snapped.y + snapped.h, o.y + o.h)
    })
  }
  if (yPick) {
    const o = yPick.other
    guides.push({
      axis: 'h',
      pos: yPick.pos,
      from: Math.min(snapped.x, o.x),
      to: Math.max(snapped.x + snapped.w, o.x + o.w)
    })
  }

  return { dx, dy, guides }
}
