// pipelineWalk.test.ts
//
// PURE unit tests for the Slipstream Pipeline Walk traversal (lib/pipelineWalk.ts).
// No DOM, no stores, no IPC — every function takes plain data and returns plain
// data, so these run under `node --test` (with a TS loader) or vitest, mirroring
// conduits.test.ts / criticalPath.test.ts. They lock the empty graph, the single
// chain hop down/up, fan-out (candidates), fan-in, deleted-endpoint pruning, the
// self-edge skip, parallel dedup, and frecency-ordered candidates.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  downstreamOf,
  upstreamOf,
  pickWalkTarget,
  type WalkRule
} from './pipelineWalk'

function rule(sourceId: string, targetId: string): WalkRule {
  return { sourceId, targetId }
}
/** Convenience: a Set of node ids "still on the canvas". */
function ids(...xs: string[]): Set<string> {
  return new Set(xs)
}

test('no rules -> empty in both directions', () => {
  assert.deepEqual(downstreamOf('a', [], ids('a', 'b')), [])
  assert.deepEqual(upstreamOf('a', [], ids('a', 'b')), [])
  assert.deepEqual(pickWalkTarget('a', 'down', [], ids('a')), {})
  assert.deepEqual(pickWalkTarget('a', 'up', [], ids('a')), {})
})

test('single chain hop down and up', () => {
  // a -> b -> c
  const rules = [rule('a', 'b'), rule('b', 'c')]
  const present = ids('a', 'b', 'c')
  assert.deepEqual(downstreamOf('a', rules, present), ['b'])
  assert.deepEqual(downstreamOf('b', rules, present), ['c'])
  assert.deepEqual(downstreamOf('c', rules, present), [])
  assert.deepEqual(upstreamOf('c', rules, present), ['b'])
  assert.deepEqual(upstreamOf('b', rules, present), ['a'])
  assert.deepEqual(upstreamOf('a', rules, present), [])
  // pickWalkTarget collapses the single-partner case to a direct target.
  assert.deepEqual(pickWalkTarget('a', 'down', rules, present), { targetId: 'b' })
  assert.deepEqual(pickWalkTarget('c', 'up', rules, present), { targetId: 'b' })
  // dead ends.
  assert.deepEqual(pickWalkTarget('c', 'down', rules, present), {})
  assert.deepEqual(pickWalkTarget('a', 'up', rules, present), {})
})

test('fan-out -> downstream candidates', () => {
  // planner feeds builder, tester, reviewer
  const rules = [rule('p', 'b'), rule('p', 't'), rule('p', 'r')]
  const present = ids('p', 'b', 't', 'r')
  assert.deepEqual(downstreamOf('p', rules, present), ['b', 't', 'r'])
  assert.deepEqual(pickWalkTarget('p', 'down', rules, present), {
    candidates: ['b', 't', 'r']
  })
})

test('fan-in -> upstream candidates', () => {
  // builder, tester, reviewer all feed reporter
  const rules = [rule('b', 'rep'), rule('t', 'rep'), rule('r', 'rep')]
  const present = ids('b', 't', 'r', 'rep')
  assert.deepEqual(upstreamOf('rep', rules, present), ['b', 't', 'r'])
  assert.deepEqual(pickWalkTarget('rep', 'up', rules, present), {
    candidates: ['b', 't', 'r']
  })
})

test('prunes deleted endpoints', () => {
  const rules = [rule('a', 'b'), rule('a', 'c')]
  // 'b' was deleted from the canvas; only 'c' remains a live partner.
  const present = ids('a', 'c')
  assert.deepEqual(downstreamOf('a', rules, present), ['c'])
  assert.deepEqual(pickWalkTarget('a', 'down', rules, present), { targetId: 'c' })
  // both partners gone -> dead end.
  assert.deepEqual(downstreamOf('a', rules, ids('a')), [])
})

test('skips self-edges', () => {
  const rules = [rule('a', 'a'), rule('a', 'b')]
  const present = ids('a', 'b')
  assert.deepEqual(downstreamOf('a', rules, present), ['b'])
  assert.deepEqual(upstreamOf('a', rules, present), [])
})

test('dedups parallel duplicate edges (first wins, order preserved)', () => {
  const rules = [rule('a', 'b'), rule('a', 'b'), rule('a', 'c')]
  const present = ids('a', 'b', 'c')
  assert.deepEqual(downstreamOf('a', rules, present), ['b', 'c'])
})

test('frecency orders candidates (recency, then count) without auto-picking', () => {
  const rules = [rule('p', 'b'), rule('p', 't'), rule('p', 'r')]
  const present = ids('p', 'b', 't', 'r')
  const frecency = {
    b: { count: 1, lastTs: 100 },
    t: { count: 9, lastTs: 300 }, // most recent -> first
    r: { count: 5, lastTs: 200 }
  }
  const res = pickWalkTarget('p', 'down', rules, present, frecency)
  assert.deepEqual(res, { candidates: ['t', 'r', 'b'] })
})

test('null/empty current is a dead end', () => {
  const rules = [rule('a', 'b')]
  assert.deepEqual(pickWalkTarget(null, 'down', rules, ids('a', 'b')), {})
  assert.deepEqual(pickWalkTarget('', 'up', rules, ids('a', 'b')), {})
})
