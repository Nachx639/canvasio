// beacon.test.ts
//
// PURE unit tests for the Beacon content search (lib/beacon.ts). No DOM, no
// stores, no IPC — feed an explicit Map<nodeId,string[]> scrollback snapshot +
// needle, assert the ranked/grouped/capped hits, case-insensitivity, excerpt
// windowing, deterministic node-reading-order ranking, and the empty-needle and
// caps edge cases. Runs under `node --test` (with a TS loader) or vitest.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { search } from './beacon'

const snap = (entries: Array<[string, string[]]>): Map<string, string[]> => new Map(entries)

test('search — basic single-node match with line + col', () => {
  const s = snap([['a', ['hello world', 'no match here', 'the world ends']]])
  const r = search(s, 'world')
  assert.equal(r.total, 2)
  assert.equal(r.groups.length, 1)
  assert.equal(r.groups[0].nodeId, 'a')
  assert.equal(r.groups[0].count, 2)
  assert.equal(r.hits.length, 2)
  assert.equal(r.hits[0].line, 0)
  assert.equal(r.hits[0].col, 6)
  assert.equal(r.hits[1].line, 2)
  assert.equal(r.hits[1].col, 4)
  assert.equal(r.capped, false)
})

test('search — empty / whitespace needle yields no hits', () => {
  const s = snap([['a', ['anything']]])
  assert.equal(search(s, '').total, 0)
  assert.equal(search(s, '   ').total, 0)
  assert.equal(search(s, '\t').hits.length, 0)
  assert.deepEqual(search(s, '').groups, [])
})

test('search — case-insensitive', () => {
  const s = snap([['a', ['ERROR: boom', 'minor error', 'Error again']]])
  const r = search(s, 'error')
  assert.equal(r.total, 3)
  assert.equal(r.groups[0].count, 3)
})

test('search — no match returns empty result', () => {
  const s = snap([['a', ['foo', 'bar']]])
  const r = search(s, 'zzz')
  assert.equal(r.total, 0)
  assert.equal(r.groups.length, 0)
  assert.equal(r.hits.length, 0)
})

test('search — multi-node ranking follows Map reading order, then line index', () => {
  const s = snap([
    ['n1', ['x match', 'y match']],
    ['n2', ['z match']]
  ])
  const r = search(s, 'match')
  assert.equal(r.groups.length, 2)
  assert.equal(r.groups[0].nodeId, 'n1')
  assert.equal(r.groups[1].nodeId, 'n2')
  // Flat hits concatenate groups in order: n1 line0, n1 line1, n2 line0.
  assert.deepEqual(
    r.hits.map((h) => [h.nodeId, h.line]),
    [
      ['n1', 0],
      ['n1', 1],
      ['n2', 0]
    ]
  )
})

test('search — nodes with no match are omitted', () => {
  const s = snap([
    ['n1', ['nothing relevant']],
    ['n2', ['found it']]
  ])
  const r = search(s, 'found')
  assert.equal(r.groups.length, 1)
  assert.equal(r.groups[0].nodeId, 'n2')
})

test('search — empty line arrays are skipped', () => {
  const s = snap([
    ['n1', []],
    ['n2', ['hit']]
  ])
  const r = search(s, 'hit')
  assert.equal(r.groups.length, 1)
  assert.equal(r.groups[0].nodeId, 'n2')
})

test('search — excerpt windows around the match with ellipsis + correct offset', () => {
  const long = 'A'.repeat(200) + 'NEEDLE' + 'B'.repeat(200)
  const s = snap([['a', [long]]])
  const r = search(s, 'needle', { context: 10 })
  const h = r.hits[0]
  // Clipped both sides => leading + trailing ellipsis.
  assert.ok(h.excerpt.startsWith('…'))
  assert.ok(h.excerpt.endsWith('…'))
  // The highlighted slice of the excerpt equals the matched text (case from src).
  assert.equal(h.matchLen, 6)
  assert.equal(h.excerpt.substr(h.excerptCol, h.matchLen), 'NEEDLE')
})

test('search — short line excerpt has no ellipsis and offset is exact', () => {
  const s = snap([['a', ['  pre needle post  ']]])
  const r = search(s, 'needle', { context: 60 })
  const h = r.hits[0]
  assert.equal(h.excerpt, 'pre needle post')
  assert.equal(h.excerpt.substr(h.excerptCol, h.matchLen), 'needle')
})

test('search — per-node cap clips surfaced hits but count stays true', () => {
  const lines = Array.from({ length: 50 }, () => 'match')
  const s = snap([['a', lines]])
  const r = search(s, 'match', { perNode: 5 })
  assert.equal(r.groups[0].count, 50) // true total
  assert.equal(r.groups[0].hits.length, 5) // surfaced clipped
  assert.equal(r.total, 50)
  assert.equal(r.capped, true)
})

test('search — global cap clips total surfaced hits across nodes', () => {
  const lines = Array.from({ length: 10 }, () => 'match')
  const s = snap([
    ['n1', lines],
    ['n2', lines],
    ['n3', lines]
  ])
  const r = search(s, 'match', { cap: 12, perNode: 100 })
  assert.equal(r.total, 30) // true grand total
  assert.equal(r.hits.length, 12) // surfaced clipped to global cap
  assert.equal(r.capped, true)
})

test('search — exactly-at-cap is not flagged as capped', () => {
  const s = snap([['a', ['match', 'match', 'match']]])
  const r = search(s, 'match', { cap: 3, perNode: 3 })
  assert.equal(r.hits.length, 3)
  assert.equal(r.capped, false)
})
