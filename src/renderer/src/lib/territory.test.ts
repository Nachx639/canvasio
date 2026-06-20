// territory.test.ts
//
// PURE unit tests for the Districts geometry (lib/territory.ts). No DOM, no
// stores, no IPC — every function takes plain data, so these run under
// `node --test` (with a TS loader) or vitest. They lock the bbox containment,
// region framing, relay-pipeline clustering, and spatial-band clustering.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  nodesInRegion,
  regionBounds,
  suggestDistricts,
  type NodeBox,
  type RelayEdge
} from './territory'
import type { Region } from '../store/regions'

function node(id: string, x: number, y: number, w = 100, h = 100): NodeBox {
  return { id, x, y, w, h }
}

function region(over: Partial<Region>): Region {
  return { id: 'r', name: 'R', x: 0, y: 0, w: 100, h: 100, color: '#fff', ...over }
}

test('nodesInRegion: center-inside containment', () => {
  const r = region({ x: 0, y: 0, w: 300, h: 300 })
  const inside = node('a', 50, 50) // center 100,100 inside
  const outside = node('b', 400, 400) // center 450,450 outside
  const result = nodesInRegion(r, [inside, outside])
  assert.deepEqual(result.map((n) => n.id), ['a'])
})

test('nodesInRegion: a node straddling the edge is owned by center', () => {
  const r = region({ x: 0, y: 0, w: 200, h: 200 })
  // center at 190,190 → inside; box extends past the right/bottom edge.
  const straddle = node('a', 140, 140)
  assert.equal(nodesInRegion(r, [straddle]).length, 1)
  // center at 210,210 → outside even though the box overlaps the edge.
  const straddleOut = node('b', 160, 160)
  assert.equal(nodesInRegion(r, [straddleOut]).length, 0)
})

test('regionBounds returns the region rectangle', () => {
  const r = region({ x: 10, y: 20, w: 300, h: 400 })
  assert.deepEqual(regionBounds(r), { x: 10, y: 20, w: 300, h: 400 })
})

test('suggestDistricts: fewer than 2 nodes yields none', () => {
  assert.deepEqual(suggestDistricts([], []), [])
  assert.deepEqual(suggestDistricts([node('a', 0, 0)], []), [])
})

test('suggestDistricts: relay-connected nodes become ONE district', () => {
  // Three nodes far apart spatially, but wired in a relay chain a->b->c.
  const nodes = [node('a', 0, 0), node('b', 2000, 2000), node('c', 4000, 4000)]
  const edges: RelayEdge[] = [
    { sourceId: 'a', targetId: 'b' },
    { sourceId: 'b', targetId: 'c' }
  ]
  const districts = suggestDistricts(nodes, edges)
  assert.equal(districts.length, 1)
  // The single district must contain all three node centers.
  const d = districts[0]
  for (const n of nodes) {
    const cx = n.x + n.w / 2
    const cy = n.y + n.h / 2
    assert.ok(cx >= d.x && cx <= d.x + d.w && cy >= d.y && cy <= d.y + d.h)
  }
})

test('suggestDistricts: un-wired nodes split into spatial bands by row', () => {
  // Two clear rows separated by a big vertical gap, no relay edges.
  const nodes = [
    node('a', 0, 0),
    node('b', 200, 10),
    node('c', 0, 1000),
    node('d', 200, 1010)
  ]
  const districts = suggestDistricts(nodes, [])
  assert.equal(districts.length, 2)
  // Row 1 district contains a & b centers; row 2 contains c & d.
  const top = districts.find((d) => d.y < 500)!
  const bottom = districts.find((d) => d.y >= 500)!
  assert.ok(top && bottom)
  assert.ok(0 + 50 >= top.x && 200 + 50 <= top.x + top.w)
})

test('suggestDistricts: relay pipeline + leftover band coexist', () => {
  const nodes = [
    node('a', 0, 0),
    node('b', 300, 0),
    node('c', 0, 1500) // unrelated, far below
  ]
  const edges: RelayEdge[] = [{ sourceId: 'a', targetId: 'b' }]
  const districts = suggestDistricts(nodes, edges)
  // One pipeline district (a,b) + one band district (c).
  assert.equal(districts.length, 2)
})
