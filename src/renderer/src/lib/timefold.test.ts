// timefold.test.ts
//
// PURE unit tests for the Timefold reconstruction kernel (lib/timefold.ts). No
// DOM, no React, no store: every function takes plain data in and returns plain
// data out. Mirrors the node:test convention used by the sibling lib tests
// (horizon.test.ts, stages.test.ts, …).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  computeRange,
  lineAtTime,
  statusAtTime,
  statusForKind,
  eventTicks,
  neighborTick,
  type TimefoldLine,
  type TimefoldEvent
} from './timefold'

const ring = (ts: number[]): TimefoldLine[] => ts.map((t) => ({ text: `line@${t}`, ts: t }))

// --- lineAtTime ------------------------------------------------------------
test('lineAtTime: null for an empty / missing ring', () => {
  assert.equal(lineAtTime([], 100), null)
  assert.equal(lineAtTime(undefined, 100), null)
})

test('lineAtTime: null when every line is after t', () => {
  assert.equal(lineAtTime(ring([50, 60, 70]), 40), null)
})

test('lineAtTime: exact ts match', () => {
  assert.equal(lineAtTime(ring([10, 20, 30]), 20)?.ts, 20)
})

test('lineAtTime: last line at-or-before t (between ticks)', () => {
  assert.equal(lineAtTime(ring([10, 20, 30]), 25)?.ts, 20)
})

test('lineAtTime: final line when t is after the last', () => {
  assert.equal(lineAtTime(ring([10, 20, 30]), 999)?.ts, 30)
})

test('lineAtTime: single-element ring on both sides', () => {
  assert.equal(lineAtTime(ring([100]), 50), null)
  assert.equal(lineAtTime(ring([100]), 100)?.ts, 100)
  assert.equal(lineAtTime(ring([100]), 150)?.ts, 100)
})

// --- statusForKind ---------------------------------------------------------
test('statusForKind: maps live transition kinds to statuses', () => {
  assert.equal(statusForKind('work-start'), 'working')
  assert.equal(statusForKind('done'), 'done')
  assert.equal(statusForKind('error'), 'error')
  assert.equal(statusForKind('waiting'), 'idle')
})

test('statusForKind: null for quiet lifecycle kinds', () => {
  assert.equal(statusForKind('spawn'), null)
  assert.equal(statusForKind('close'), null)
  assert.equal(statusForKind('relay'), null)
  assert.equal(statusForKind('nonsense'), null)
})

// --- statusAtTime ----------------------------------------------------------
const events: TimefoldEvent[] = [
  { nodeId: 'a', ts: 10, kind: 'spawn' },
  { nodeId: 'a', ts: 20, kind: 'work-start' },
  { nodeId: 'b', ts: 25, kind: 'work-start' },
  { nodeId: 'a', ts: 40, kind: 'error' },
  { nodeId: 'a', ts: 60, kind: 'done' }
]

test('statusAtTime: null before any status-bearing event', () => {
  assert.equal(statusAtTime(events, 'a', 5), null)
  // spawn alone (ts 10) carries no status.
  assert.equal(statusAtTime(events, 'a', 15), null)
})

test('statusAtTime: latest status at-or-before t for the right node', () => {
  assert.equal(statusAtTime(events, 'a', 20), 'working')
  assert.equal(statusAtTime(events, 'a', 39), 'working')
  assert.equal(statusAtTime(events, 'a', 40), 'error')
  assert.equal(statusAtTime(events, 'a', 100), 'done')
})

test('statusAtTime: isolates by nodeId', () => {
  assert.equal(statusAtTime(events, 'b', 100), 'working')
  assert.equal(statusAtTime(events, 'b', 24), null)
})

// --- computeRange ----------------------------------------------------------
test('computeRange: null over empty substrates', () => {
  assert.equal(computeRange({}, []), null)
})

test('computeRange: spans both echo lines and mission events', () => {
  const echo = { a: ring([30, 90]), b: ring([45]) }
  const evs: TimefoldEvent[] = [
    { nodeId: 'a', ts: 10, kind: 'spawn' },
    { nodeId: 'b', ts: 120, kind: 'done' }
  ]
  assert.deepEqual(computeRange(echo, evs), { minTs: 10, maxTs: 120 })
})

test('computeRange: works with only echo or only mission present', () => {
  assert.deepEqual(computeRange({ a: ring([5, 8]) }, []), { minTs: 5, maxTs: 8 })
  assert.deepEqual(computeRange({}, [{ nodeId: 'a', ts: 7, kind: 'done' }]), {
    minTs: 7,
    maxTs: 7
  })
})

// --- eventTicks ------------------------------------------------------------
test('eventTicks: merges, dedupes and sorts all timestamps', () => {
  const echo = { a: ring([30, 10]), b: ring([30, 50]) }
  const evs: TimefoldEvent[] = [
    { nodeId: 'a', ts: 50, kind: 'done' },
    { nodeId: 'b', ts: 5, kind: 'spawn' }
  ]
  assert.deepEqual(eventTicks(echo, evs), [5, 10, 30, 50])
})

test('eventTicks: empty over empty substrates', () => {
  assert.deepEqual(eventTicks({}, []), [])
})

// --- neighborTick ----------------------------------------------------------
const ticks = [10, 20, 30]
test('neighborTick: steps forward to the next strictly-greater tick', () => {
  assert.equal(neighborTick(ticks, 10, 1), 20)
  assert.equal(neighborTick(ticks, 15, 1), 20)
  assert.equal(neighborTick(ticks, 30, 1), null)
})

test('neighborTick: steps back to the previous strictly-lesser tick', () => {
  assert.equal(neighborTick(ticks, 30, -1), 20)
  assert.equal(neighborTick(ticks, 25, -1), 20)
  assert.equal(neighborTick(ticks, 10, -1), null)
})

test('neighborTick: null with no ticks', () => {
  assert.equal(neighborTick([], 5, 1), null)
  assert.equal(neighborTick([], 5, -1), null)
})
