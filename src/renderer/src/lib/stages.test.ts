// stages.test.ts
//
// PURE unit tests for the Stages geometry + sanitize helpers (lib/stages.ts). No
// DOM, no stores, no IPC — every function takes plain data, so these run under
// `node --test` (with a TS loader) or vitest. They lock the box-union math
// (boundsOf), the nodeId pruning (pruneStageIds), and the restore sanitize
// (sanitizeStages) — the three pieces canvas.ts + loadLayout rely on.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { boundsOf, pruneStageIds, sanitizeStages, MAX_STAGES, type Stage } from './stages'
import type { CanvasNode } from '../store/canvas'

function node(id: string, x: number, y: number, w = 100, h = 100): CanvasNode {
  return { id, kind: 'terminal', title: id, x, y, w, h, z: 1 }
}

test('boundsOf: unions the boxes of exactly the requested ids', () => {
  const nodes = [node('a', 0, 0, 100, 100), node('b', 200, 50, 100, 100), node('c', 1000, 1000)]
  const b = boundsOf(nodes, ['a', 'b'])
  assert.ok(b)
  assert.deepEqual(b, { minX: 0, minY: 0, maxX: 300, maxY: 150 })
})

test('boundsOf: a single id frames just that node', () => {
  const nodes = [node('a', 10, 20, 40, 60), node('b', 500, 500)]
  const b = boundsOf(nodes, ['a'])
  assert.deepEqual(b, { minX: 10, minY: 20, maxX: 50, maxY: 80 })
})

test('boundsOf: ids not present are ignored; all-missing yields null', () => {
  const nodes = [node('a', 0, 0)]
  // 'ghost' is absent, so only 'a' contributes.
  const b = boundsOf(nodes, ['a', 'ghost'])
  assert.deepEqual(b, { minX: 0, minY: 0, maxX: 100, maxY: 100 })
  // Every id missing -> null (caller never frames an empty box / NaN camera).
  assert.equal(boundsOf(nodes, ['x', 'y']), null)
  assert.equal(boundsOf([], ['a']), null)
})

test('boundsOf: accepts a Set as well as an array', () => {
  const nodes = [node('a', 0, 0), node('b', 100, 100)]
  const b = boundsOf(nodes, new Set(['a', 'b']))
  assert.deepEqual(b, { minX: 0, minY: 0, maxX: 200, maxY: 200 })
})

test('pruneStageIds: drops absent ids, de-dupes, preserves order', () => {
  const present = new Set(['a', 'b', 'c'])
  assert.deepEqual(pruneStageIds(['a', 'gone', 'b', 'a', 'c'], present), ['a', 'b', 'c'])
  // Order is preserved (not alphabetized).
  assert.deepEqual(pruneStageIds(['c', 'a'], present), ['c', 'a'])
  // Nothing survives -> empty array.
  assert.deepEqual(pruneStageIds(['x', 'y'], present), [])
})

test('sanitizeStages: prunes member ids to live nodes and drops empty scenes', () => {
  const present = new Set(['a', 'b'])
  const raw: Stage[] = [
    { id: 's1', name: 'Backend', nodeIds: ['a', 'gone', 'b'] },
    { id: 's2', name: 'Dead', nodeIds: ['gone1', 'gone2'] } // fully stale -> dropped
  ]
  const out = sanitizeStages(raw, present)
  assert.equal(out.length, 1)
  assert.equal(out[0].id, 's1')
  assert.equal(out[0].name, 'Backend')
  assert.deepEqual(out[0].nodeIds, ['a', 'b'])
})

test('sanitizeStages: tolerates malformed input and supplies defaults', () => {
  const present = new Set(['a'])
  const raw = [
    null,
    42,
    { name: 'No ids' }, // missing nodeIds -> skipped
    { nodeIds: ['a'] }, // missing name -> default name, missing id -> generated
    { id: 's', name: '   ', nodeIds: ['a', 7, 'b'] } // blank name -> default, non-string id filtered
  ]
  const out = sanitizeStages(raw as unknown, present)
  assert.equal(out.length, 2)
  for (const st of out) {
    assert.ok(st.id && typeof st.id === 'string')
    assert.ok(st.name && st.name.trim().length > 0)
    assert.deepEqual(st.nodeIds, ['a'])
  }
  // Non-array input is safe.
  assert.deepEqual(sanitizeStages(undefined, present), [])
  assert.deepEqual(sanitizeStages('nope' as unknown, present), [])
})

test('sanitizeStages: caps at MAX_STAGES', () => {
  const present = new Set(['a'])
  const raw: Stage[] = Array.from({ length: MAX_STAGES + 5 }, (_, i) => ({
    id: `s${i}`,
    name: `S${i}`,
    nodeIds: ['a']
  }))
  assert.equal(sanitizeStages(raw, present).length, MAX_STAGES)
})

test('sanitizeStages: re-ids duplicate ids so two scenes never share one id', () => {
  const present = new Set(['a', 'b'])
  const raw: Stage[] = [
    { id: 'dup', name: 'One', nodeIds: ['a'] },
    { id: 'dup', name: 'Two', nodeIds: ['b'] }
  ]
  const out = sanitizeStages(raw, present)
  assert.equal(out.length, 2)
  assert.notEqual(out[0].id, out[1].id)
})
