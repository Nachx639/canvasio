// sentinel.test.ts
//
// PURE unit tests for the Sentinel evaluator (lib/sentinel.ts). No DOM, no
// stores, no IPC — feed explicit orders + a folded latest-event map + Lens lines,
// assert which order ids fire. Runs under `node --test` (with a TS loader) or
// vitest. Locks each trigger kind (waiting/error/done/match), the
// already-true-on-arm guard (baselineTs), regex safety (invalid pattern never
// throws and never fires), the fire-once contract (firedTs!==null stays quiet),
// and removed-node pruning.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  compilePattern,
  orderFires,
  evaluateOrders,
  type SentinelOrder
} from './sentinel'
import type { MissionEvent } from '../store/mission'
import type { LensLine } from '../store/lens'

const ev = (nodeId: string, kind: MissionEvent['kind'], ts: number): MissionEvent => ({
  id: `${nodeId}-${ts}`,
  ts,
  nodeId,
  title: nodeId,
  kind
})

const latest = (...events: MissionEvent[]): Map<string, MissionEvent> => {
  const m = new Map<string, MissionEvent>()
  for (const e of events) m.set(e.nodeId, e)
  return m
}

const order = (over: Partial<SentinelOrder>): SentinelOrder => ({
  id: 'o1',
  nodeId: 'a',
  kind: 'done',
  baselineTs: 0,
  firedTs: null,
  autoFly: false,
  ...over
})

const live = (...ids: string[]): Set<string> => new Set(ids)

test('compilePattern — empty / whitespace / invalid => null; valid => RegExp', () => {
  assert.equal(compilePattern(undefined), null)
  assert.equal(compilePattern(''), null)
  assert.equal(compilePattern('   '), null)
  assert.equal(compilePattern('('), null) // unbalanced — must not throw
  assert.ok(compilePattern('(y/n)') instanceof RegExp)
})

test('status kind — fires when latest event newer than baseline matches kind', () => {
  const o = order({ kind: 'waiting', nodeId: 'a', baselineTs: 100 })
  assert.equal(orderFires(o, latest(ev('a', 'waiting', 200)), {}), true)
})

test('status kind — wrong kind does not fire', () => {
  const o = order({ kind: 'error', nodeId: 'a', baselineTs: 100 })
  assert.equal(orderFires(o, latest(ev('a', 'done', 200)), {}), false)
})

test('already-true-on-arm guard — event at/below baseline never fires', () => {
  // status already 'waiting' at arm-time (ts === baseline) must NOT fire.
  const o = order({ kind: 'waiting', nodeId: 'a', baselineTs: 200 })
  assert.equal(orderFires(o, latest(ev('a', 'waiting', 200)), {}), false)
  assert.equal(orderFires(o, latest(ev('a', 'waiting', 150)), {}), false)
  // a fresh transition AFTER the baseline does fire.
  assert.equal(orderFires(o, latest(ev('a', 'waiting', 201)), {}), true)
})

test('match kind — fires on a newer Lens line matching the regex', () => {
  const o = order({ kind: 'match', nodeId: 'a', pattern: 'tests? passed', baselineTs: 100 })
  const lens: Record<string, LensLine> = { a: { text: '142 tests passed', ts: 200 } }
  assert.equal(orderFires(o, new Map(), lens), true)
})

test('match kind — line at/below baseline does not fire (already on screen)', () => {
  const o = order({ kind: 'match', nodeId: 'a', pattern: 'error', baselineTs: 200 })
  const lens: Record<string, LensLine> = { a: { text: 'fatal error', ts: 200 } }
  assert.equal(orderFires(o, new Map(), lens), false)
})

test('match kind — non-matching newer line does not fire', () => {
  const o = order({ kind: 'match', nodeId: 'a', pattern: '\\(y/n\\)', baselineTs: 0 })
  const lens: Record<string, LensLine> = { a: { text: 'building project…', ts: 200 } }
  assert.equal(orderFires(o, new Map(), lens), false)
})

test('match kind — invalid pattern never throws and never fires', () => {
  const o = order({ kind: 'match', nodeId: 'a', pattern: '(', baselineTs: 0 })
  const lens: Record<string, LensLine> = { a: { text: 'anything (here)', ts: 200 } }
  assert.doesNotThrow(() => orderFires(o, new Map(), lens))
  assert.equal(orderFires(o, new Map(), lens), false)
})

test('match kind — missing Lens line for node does not fire', () => {
  const o = order({ kind: 'match', nodeId: 'a', pattern: '.*', baselineTs: 0 })
  assert.equal(orderFires(o, new Map(), {}), false)
})

test('evaluateOrders — returns only newly-firing, still-armed orders', () => {
  const orders: SentinelOrder[] = [
    order({ id: 'fire', nodeId: 'a', kind: 'done', baselineTs: 100 }),
    order({ id: 'quiet-wrong', nodeId: 'b', kind: 'error', baselineTs: 100 }),
    order({ id: 'already-fired', nodeId: 'a', kind: 'done', baselineTs: 100, firedTs: 500 })
  ]
  const map = latest(ev('a', 'done', 200), ev('b', 'waiting', 200))
  const out = evaluateOrders(orders, map, {}, live('a', 'b'))
  assert.deepEqual(out, ['fire'])
})

test('evaluateOrders — removed node is pruned (never fires at a gone node)', () => {
  const orders: SentinelOrder[] = [
    order({ id: 'gone', nodeId: 'x', kind: 'done', baselineTs: 0 })
  ]
  const map = latest(ev('x', 'done', 200))
  // node 'x' is NOT in the live set => must not fire.
  assert.deepEqual(evaluateOrders(orders, map, {}, live('a')), [])
})

test('evaluateOrders — empty input => empty output', () => {
  assert.deepEqual(evaluateOrders([], new Map(), {}, live()), [])
})
