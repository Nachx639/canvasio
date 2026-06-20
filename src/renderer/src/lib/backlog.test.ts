// backlog.test.ts
//
// PURE unit tests for the Backlog math (lib/backlog.ts). No DOM, no stores, no
// IPC — feed explicit Echo rings + visit watermarks, assert the unseen count /
// peak. Runs under `node --test` (with a TS loader) or vitest. Locks the count
// math (older/newer/equal-to-watermark, never-visited => all unseen, empty ring)
// and the peak selection (highest count, recency tie-break, all-seen => null).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { countUnseen, newestTs, pickPeak, totalUnseen } from './backlog'
import type { EchoLine } from '../store/echo'

const line = (ts: number, text = `l${ts}`): EchoLine => ({ text, ts })

test('countUnseen — only lines strictly newer than the watermark count', () => {
  const ring = [line(10), line(20), line(30)]
  assert.equal(countUnseen(ring, 20), 1) // only ts=30 is > 20
  assert.equal(countUnseen(ring, 5), 3) // all newer
  assert.equal(countUnseen(ring, 30), 0) // none newer (equal does not count)
})

test('countUnseen — never visited (watermark 0/NaN) => every line is unseen', () => {
  const ring = [line(10), line(20)]
  assert.equal(countUnseen(ring, 0), 2)
  assert.equal(countUnseen(ring, Number.NaN), 2)
})

test('countUnseen — empty / absent ring => 0', () => {
  assert.equal(countUnseen([], 0), 0)
  assert.equal(countUnseen(undefined, 0), 0)
})

test('newestTs — max ts of the ring, 0 when empty', () => {
  assert.equal(newestTs([line(10), line(40), line(25)]), 40)
  assert.equal(newestTs([]), 0)
  assert.equal(newestTs(undefined), 0)
})

test('pickPeak — node with the highest unseen count wins', () => {
  const visits = { a: { lastTs: 0 }, b: { lastTs: 0 } }
  const echo = {
    a: [line(10)],
    b: [line(10), line(20), line(30)]
  }
  assert.equal(pickPeak(['a', 'b'], visits, echo), 'b')
})

test('pickPeak — visited node zeroes out; unvisited node wins', () => {
  // 'a' was looked at AFTER all its lines (all seen); 'b' never visited.
  const visits = { a: { lastTs: 100 } }
  const echo = {
    a: [line(10), line(20)],
    b: [line(5)]
  }
  assert.equal(pickPeak(['a', 'b'], visits, echo), 'b')
})

test('pickPeak — tie on count breaks toward the more-recent newest line', () => {
  const visits = { a: { lastTs: 0 }, b: { lastTs: 0 } }
  const echo = {
    a: [line(10), line(50)], // count 2, newest 50
    b: [line(10), line(40)] // count 2, newest 40
  }
  assert.equal(pickPeak(['a', 'b'], visits, echo), 'a')
})

test('pickPeak — nobody has unseen activity => null', () => {
  const visits = { a: { lastTs: 100 }, b: { lastTs: 100 } }
  const echo = { a: [line(10)], b: [line(20)] }
  assert.equal(pickPeak(['a', 'b'], visits, echo), null)
})

test('pickPeak — empty input => null', () => {
  assert.equal(pickPeak([], {}, {}), null)
})

test('totalUnseen — sums unseen across all given nodes only', () => {
  const visits = { a: { lastTs: 15 } } // 'b' never visited
  const echo = {
    a: [line(10), line(20), line(30)], // unseen: 20,30 => 2
    b: [line(5), line(6)], // never visited => 2
    c: [line(99)] // not in nodeIds => ignored
  }
  assert.equal(totalUnseen(['a', 'b'], visits, echo), 4)
})
