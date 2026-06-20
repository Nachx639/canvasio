// conduits.test.ts
//
// PURE unit tests for the Relay Conduits geometry (lib/conduits.ts). No DOM, no
// stores, no IPC — every function takes plain data and returns plain data, so
// these run under `node --test` (with a TS loader) or vitest, mirroring
// criticalPath.test.ts. They lock the empty graph, the missing-endpoint drop, the
// self-edge skip, parallel dedup, and the border-anchor clamp math.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  computeConduits,
  borderAnchor,
  bezierControls,
  arrowHead,
  type ConduitNode,
  type ConduitRule
} from './conduits'

/** A 100x100 box anchored at (x,y) with an optional agent kind. */
function node(id: string, x: number, y: number, agent?: ConduitNode['agent']): ConduitNode {
  return { id, x, y, w: 100, h: 100, agent }
}
function rule(sourceId: string, targetId: string): ConduitRule {
  return { sourceId, targetId }
}

test('empty graph -> no conduits', () => {
  assert.deepEqual(computeConduits([], []), [])
  assert.deepEqual(computeConduits([node('a', 0, 0)], []), [])
})

test('drops an edge whose endpoint is missing', () => {
  const nodes = [node('a', 0, 0)]
  // target 'b' does not exist
  assert.deepEqual(computeConduits(nodes, [rule('a', 'b')]), [])
  // source 'z' does not exist
  assert.deepEqual(computeConduits(nodes, [rule('z', 'a')]), [])
})

test('skips self-edges', () => {
  const nodes = [node('a', 0, 0)]
  assert.deepEqual(computeConduits(nodes, [rule('a', 'a')]), [])
})

test('dedups parallel edges, keeping the first', () => {
  const nodes = [node('a', 0, 0), node('b', 300, 0)]
  const out = computeConduits(nodes, [rule('a', 'b'), rule('a', 'b')])
  assert.equal(out.length, 1)
  assert.equal(out[0].id, 'a->b')
  // a reversed edge is a DIFFERENT pair, so it is kept.
  const out2 = computeConduits(nodes, [rule('a', 'b'), rule('b', 'a')])
  assert.equal(out2.length, 2)
})

test('carries the source agent kind as the edge color key', () => {
  const nodes = [node('a', 0, 0, 'claude'), node('b', 300, 0, 'codex')]
  const out = computeConduits(nodes, [rule('a', 'b')])
  assert.equal(out[0].kind, 'claude')
})

test('anchors clamp to node borders, not centers (horizontal)', () => {
  // a centered at (50,50), b centered at (350,50): purely horizontal.
  const nodes = [node('a', 0, 0), node('b', 300, 0)]
  const [c] = computeConduits(nodes, [rule('a', 'b')])
  // source border anchor: right edge of a (x=100), mid height (y=50).
  assert.equal(c.x1, 100)
  assert.equal(c.y1, 50)
  // target border anchor: left edge of b (x=300), mid height (y=50).
  assert.equal(c.x2, 300)
  assert.equal(c.y2, 50)
})

test('borderAnchor exits the correct face for a diagonal target', () => {
  const n = node('a', 0, 0) // center (50,50), half-extent 50
  // toward a point far to the lower-right at 45° -> exits the corner-ish, but the
  // dominant axis decides: equal dx/dy hits both faces simultaneously at the
  // corner (100,100).
  const p = borderAnchor(n, { x: 1050, y: 1050 })
  assert.equal(p.x, 100)
  assert.equal(p.y, 100)
  // toward a point mostly to the right (shallow angle) -> exits the RIGHT face.
  const q = borderAnchor(n, { x: 1050, y: 60 })
  assert.equal(q.x, 100)
  assert.ok(q.y > 50 && q.y < 60)
})

test('borderAnchor returns center for a zero-length direction', () => {
  const n = node('a', 0, 0)
  assert.deepEqual(borderAnchor(n, { x: 50, y: 50 }), { x: 50, y: 50 })
})

test('bezier controls and arrowhead are finite, well-formed', () => {
  const nodes = [node('a', 0, 0), node('b', 300, 200)]
  const [c] = computeConduits(nodes, [rule('a', 'b')])
  const ctrl = bezierControls(c)
  for (const v of Object.values(ctrl)) assert.ok(Number.isFinite(v))
  const head = arrowHead(c)
  // three "x,y" pairs separated by spaces.
  const pts = head.split(' ')
  assert.equal(pts.length, 3)
  for (const pair of pts) {
    const [x, y] = pair.split(',').map(Number)
    assert.ok(Number.isFinite(x) && Number.isFinite(y))
  }
})
