// snapGuides.test.ts
//
// PURE unit tests for Magnetic Align's snap geometry (lib/snapGuides.ts). No DOM,
// no stores, no IPC — computeSnap takes plain boxes and returns plain deltas, so
// these run under `node --test` (with native TS type-stripping) or vitest,
// mirroring declutter.test.ts / pipelineWalk.test.ts. They lock left-edge align,
// center snap, the out-of-threshold no-op, picking the closest of several
// candidates, the Alt-bypass identity, and zoom-scaled tolerance.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { computeSnap, type SnapBox } from './snapGuides'

const box = (x: number, y: number, w = 100, h = 80): SnapBox => ({ x, y, w, h })

test('snaps onto a neighbor left edge within threshold', () => {
  // moving left edge at x=103, neighbor left edge at x=100 → dx = -3.
  const moving = box(103, 500)
  const other = box(100, 0)
  const r = computeSnap(moving, [other], { zoom: 1, threshold: 6 })
  assert.equal(r.dx, -3)
  assert.equal(r.dy, 0)
  assert.equal(r.guides.length, 1)
  assert.equal(r.guides[0].axis, 'v')
  assert.equal(r.guides[0].pos, 100)
})

test('center-to-center snap on both axes', () => {
  // moving center (50+2, 40+2) vs other center (50,40): dx=-2, dy=-2.
  const moving = box(2, 2)
  const other = box(0, 0)
  const r = computeSnap(moving, [other], { zoom: 1, threshold: 6 })
  assert.equal(r.dx, -2)
  assert.equal(r.dy, -2)
  assert.equal(r.guides.length, 2)
})

test('no snap when every reference is out of threshold', () => {
  const moving = box(200, 600)
  const other = box(0, 0)
  const r = computeSnap(moving, [other], { zoom: 1, threshold: 6 })
  assert.equal(r.dx, 0)
  assert.equal(r.dy, 0)
  assert.deepEqual(r.guides, [])
})

test('picks the closest candidate of several', () => {
  // moving left edge at 105. Candidates with left edges at 100 (Δ-5) and 103 (Δ-2).
  const moving = box(105, 500)
  const far = box(100, 0)
  const near = box(103, 1000)
  const r = computeSnap(moving, [far, near], { zoom: 1, threshold: 8 })
  assert.equal(r.dx, -2)
  assert.equal(r.guides[0].pos, 103)
})

test('Alt-bypass returns identity (no snap, no guides)', () => {
  const moving = box(101, 501)
  const other = box(100, 500)
  const r = computeSnap(moving, [other], { zoom: 1, threshold: 6, bypass: true })
  assert.equal(r.dx, 0)
  assert.equal(r.dy, 0)
  assert.deepEqual(r.guides, [])
})

test('threshold is zoom-scaled: tight world tolerance when zoomed in', () => {
  // At zoom=3, a 6px screen threshold is only 2 world units. A 3-unit gap misses.
  const moving = box(103, 500)
  const other = box(100, 0)
  const r = computeSnap(moving, [other], { zoom: 3, threshold: 6 })
  assert.equal(r.dx, 0)
  // But a 1-unit gap snaps (1 <= 2).
  const r2 = computeSnap(box(101, 500), [other], { zoom: 3, threshold: 6 })
  assert.equal(r2.dx, -1)
})

test('empty neighbor list is a no-op', () => {
  const r = computeSnap(box(10, 10), [], { zoom: 1 })
  assert.equal(r.dx, 0)
  assert.equal(r.dy, 0)
  assert.deepEqual(r.guides, [])
})

test('vertical guide spans the union of both boxes', () => {
  const moving = box(100, 500, 100, 80) // y: 500..580
  const other = box(100, 0, 100, 80) // y: 0..80
  const r = computeSnap(moving, [other], { zoom: 1, threshold: 2 })
  const g = r.guides.find((x) => x.axis === 'v')!
  assert.equal(g.from, 0)
  assert.equal(g.to, 580)
})
