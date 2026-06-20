// declutter.test.ts
//
// PURE unit tests for the Declutter overlap resolver (lib/declutter.ts). No DOM,
// no stores, no IPC — resolveOverlaps takes plain boxes and returns plain deltas,
// so these run under `node --test` (with a TS loader) or vitest, mirroring
// pipelineWalk.test.ts / conduits.test.ts. They lock: the no-overlap no-op, two
// stacked boxes separating by >= gap on the cheaper axis, a non-overlapping
// bystander never moving, the selectedId anchor staying pinned, convergence
// within the iteration cap, and idempotence (running twice yields no more moves).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveOverlaps, type Box } from './declutter'

function box(id: string, x: number, y: number, w = 100, h = 100): Box {
  return { id, x, y, w, h }
}

/** True if no two boxes in the set overlap (used to assert convergence). */
function noOverlaps(boxes: Box[]): boolean {
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i]
      const b = boxes[j]
      if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) {
        return false
      }
    }
  }
  return true
}

/** Apply a delta map to a box list (mirrors the store's map-merge). */
function apply(boxes: Box[], moved: Map<string, { x: number; y: number }>): Box[] {
  return boxes.map((b) => (moved.has(b.id) ? { ...b, ...moved.get(b.id)! } : b))
}

test('no overlap -> empty delta map', () => {
  const boxes = [box('a', 0, 0), box('b', 200, 0), box('c', 0, 200)]
  const moved = resolveOverlaps(boxes)
  assert.equal(moved.size, 0)
})

test('two stacked boxes separate by >= gap on the cheaper axis', () => {
  // Identical position -> total overlap. Equal w/h so X and Y penetration tie;
  // overlapX < overlapY is false on a tie, so they separate vertically. Either
  // axis is acceptable as long as they end up apart with the gutter.
  const gap = 16
  const boxes = [box('a', 100, 100), box('b', 110, 100)]
  const moved = resolveOverlaps(boxes, { gap })
  assert.ok(moved.size >= 1, 'at least one box must move')
  const out = apply(boxes, moved)
  assert.ok(noOverlaps(out), 'boxes must no longer overlap')
  // Confirm a real gutter on whichever axis they separated.
  const [a, b] = out
  const gapX = Math.max(a.x - (b.x + b.w), b.x - (a.x + a.w))
  const gapY = Math.max(a.y - (b.y + b.h), b.y - (a.y + a.h))
  assert.ok(gapX >= gap - 1 || gapY >= gap - 1, 'separated by at least the gap on one axis')
})

test('non-overlapping bystander never moves', () => {
  const boxes = [box('a', 100, 100), box('b', 120, 100), box('far', 1000, 1000)]
  const moved = resolveOverlaps(boxes)
  assert.equal(moved.has('far'), false, 'distant box must stay put')
})

test('selectedId anchor stays pinned; the other box moves fully', () => {
  const boxes = [box('a', 100, 100), box('b', 130, 100)]
  const moved = resolveOverlaps(boxes, { anchorId: 'a' })
  assert.equal(moved.has('a'), false, 'anchor must not move')
  assert.equal(moved.has('b'), true, 'non-anchor must move off the anchor')
  const out = apply(boxes, moved)
  assert.ok(noOverlaps(out))
})

test('converges within the iteration cap for a dense cluster', () => {
  // 9 boxes all piled near the origin: must fully separate, never throw/hang.
  const boxes: Box[] = []
  for (let k = 0; k < 9; k++) boxes.push(box('n' + k, k * 5, k * 5))
  const moved = resolveOverlaps(boxes, { gap: 12, iterations: 60 })
  const out = apply(boxes, moved)
  assert.ok(noOverlaps(out), 'dense cluster must end fully separated')
})

test('idempotent: re-running on the resolved layout yields no further moves', () => {
  const boxes = [box('a', 100, 100), box('b', 115, 108), box('c', 95, 120)]
  const first = resolveOverlaps(boxes, { gap: 16 })
  const settled = apply(boxes, first)
  const second = resolveOverlaps(settled, { gap: 16 })
  assert.equal(second.size, 0, 'a clean layout must produce zero moves')
})
