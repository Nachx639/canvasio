/**
 * Pure placement helper for the voice-brain DRAWING actions (draw_note /
 * draw_shape). Given the live camera, window size, and the world-space boxes of
 * existing nodes + shapes, it finds a free spot inside the CURRENTLY VISIBLE
 * viewport (world coords) for a new box of size (w,h) that does NOT overlap any
 * existing box. Multiple shapes from a single command are spread out by feeding
 * each chosen box back in as an obstacle for the next (see placeBoxes).
 *
 * Deterministic and side-effect-free: it never reads zustand directly (callers
 * pass getState() snapshots in), so the React #185 new-ref-selector pitfall does
 * not apply. No imports beyond types.
 */

/** A world-space axis-aligned box. */
export interface Box {
  x: number
  y: number
  w: number
  h: number
}

/** Minimal camera shape this helper needs (matches useCanvas Camera). */
export interface PlacementCamera {
  x: number
  y: number
  zoom: number
}

/**
 * Screen-edge insets (px) that the app chrome (top bar, side panels, dock)
 * occupies, mirrored from canvas.ts CHROME (not exported there). Placements are
 * inset by these — converted to world units via /zoom — so a note never lands
 * under the top bar or behind a side panel.
 */
const CHROME = { top: 64, bottom: 116, left: 78, right: 190 }

/** Padding (world px) added around obstacles + between grid cells. */
const GAP = 16

/** Cap on grid-scan iterations so placement is always fast + bounded. */
const MAX_SCAN = 240

/** AABB intersection test (touching edges do NOT count as overlap). */
export function boxesOverlap(a: Box, b: Box): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y
}

/**
 * Derive the visible world rectangle from the camera + window size, inset by the
 * chrome margins. The inverse transform mirrors aiActions.spawnPos():
 *   worldX = (screenX - camera.x) / zoom.
 * Guards a 0/NaN zoom (returns a sane unit-zoom rect around the origin).
 */
export function visibleWorldRect(
  camera: PlacementCamera,
  vw: number,
  vh: number
): Box {
  const z = camera.zoom
  if (!Number.isFinite(z) || z <= 0) {
    // Degenerate camera — fall back to a window-sized rect at the world origin.
    return { x: 0, y: 0, w: Math.max(1, vw), h: Math.max(1, vh) }
  }
  const minX = (CHROME.left - camera.x) / z
  const minY = (CHROME.top - camera.y) / z
  const maxX = (vw - CHROME.right - camera.x) / z
  const maxY = (vh - CHROME.bottom - camera.y) / z
  return {
    x: minX,
    y: minY,
    w: Math.max(1, maxX - minX),
    h: Math.max(1, maxY - minY)
  }
}

/**
 * Find a free top-left {x,y} for a box of size (bw,bh) inside `vis`, avoiding all
 * `obstacles` (each padded by GAP). Scans a reading-order grid (step = box size +
 * GAP), capped at MAX_SCAN cells. Falls back to the viewport CENTRE (with a small
 * per-index spiral offset so several fallbacks don't perfectly stack) when no
 * free cell is found — it NEVER throws or returns null.
 *
 * @param index 0-based slot index (only used to vary the centre fallback).
 */
export function findFreeSpot(
  vis: Box,
  obstacles: Box[],
  bw: number,
  bh: number,
  index = 0
): { x: number; y: number } {
  const padded = obstacles.map((o) => ({
    x: o.x - GAP,
    y: o.y - GAP,
    w: o.w + GAP * 2,
    h: o.h + GAP * 2
  }))
  const fits = (x: number, y: number): boolean => {
    const cand: Box = { x, y, w: bw, h: bh }
    return !padded.some((o) => boxesOverlap(cand, o))
  }

  const stepX = bw + GAP
  const stepY = bh + GAP
  const maxX = vis.x + vis.w - bw
  const maxY = vis.y + vis.h - bh

  let scans = 0
  for (let y = vis.y; y <= maxY && scans < MAX_SCAN; y += stepY) {
    for (let x = vis.x; x <= maxX && scans < MAX_SCAN; x += stepX) {
      scans++
      if (fits(x, y)) return { x: Math.round(x), y: Math.round(y) }
    }
  }

  // No free cell within the cap (or the box is larger than the visible rect):
  // place near centre, nudged by index so a burst of fallbacks fans out a bit.
  const off = index * 28
  const cx = vis.x + vis.w / 2 - bw / 2 + off
  const cy = vis.y + vis.h / 2 - bh / 2 + off
  return { x: Math.round(cx), y: Math.round(cy) }
}

/**
 * Place `count` boxes of size (bw,bh) inside the visible viewport without
 * overlapping the existing `obstacles` NOR each other. Each chosen box is pushed
 * back into the working obstacle list before the next is computed, so a single
 * multi-shape command (draw_shape count>1) never stacks its own shapes. Returns
 * one {x,y} per requested box (always exactly `count`, clamped to >=1).
 */
export function placeBoxes(
  camera: PlacementCamera,
  vw: number,
  vh: number,
  existing: Box[],
  bw: number,
  bh: number,
  count = 1
): { x: number; y: number }[] {
  const n = Math.max(1, Math.floor(count) || 1)
  const vis = visibleWorldRect(camera, vw, vh)
  const obstacles: Box[] = existing.slice()
  const out: { x: number; y: number }[] = []
  for (let i = 0; i < n; i++) {
    const spot = findFreeSpot(vis, obstacles, bw, bh, i)
    out.push(spot)
    obstacles.push({ x: spot.x, y: spot.y, w: bw, h: bh })
  }
  return out
}
