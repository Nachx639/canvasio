// contextSync.test.ts
//
// PURE unit tests for the Context Sync supersession core (lib/contextSync.ts).
// No DOM, no stores, no IPC — every function takes plain data and returns plain
// data, so these run under `node --test` (with a TS loader / native type
// stripping) or vitest, exactly like consensus.test.ts. They lock supersession
// detection, the same-value no-op, value omission, the OLD<NEW recency guard,
// precision-over-recall (only consumers of the OLD value get hits), and dedup.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  computeStale,
  consumedFromFact,
  formatCorrection,
  hitKey,
  type Ledger,
  type ConsumedFact
} from './contextSync'

/** Minimal structural BoardFact for the tests (matches store/board.ts shape). */
function fact(over: { id: string; text: string; ts?: number }): {
  id: string
  ts: number
  text: string
} {
  return { ts: over.ts ?? 1000, id: over.id, text: over.text }
}

function consumed(subject: string, value: string, ts: number): ConsumedFact {
  return { subject, value, ts }
}

test('supersession fires for the consumer of the old value', () => {
  const ledger: Ledger = new Map([['nodeX', [consumed('api base', '/v2', 1000)]]])
  const facts = [fact({ id: 'f1', text: 'API base is /v3', ts: 2000 })]
  const hits = computeStale(ledger, facts)
  assert.equal(hits.length, 1)
  assert.deepEqual(hits[0], { nodeId: 'nodeX', subject: 'api base', oldValue: '/v2', newValue: '/v3' })
})

test('same value is a no-op (no self-revision)', () => {
  const ledger: Ledger = new Map([['nodeX', [consumed('api base', '/v2', 1000)]]])
  const facts = [fact({ id: 'f1', text: 'API base is /v2', ts: 2000 })]
  assert.deepEqual(computeStale(ledger, facts), [])
})

test('only consumers of the OLD value get hits, not unrelated nodes', () => {
  const ledger: Ledger = new Map([
    ['old1', [consumed('api base', '/v2', 1000)]],
    ['old2', [consumed('api base', '/v2', 1100)]],
    // never consumed api base — must NOT be flagged
    ['other', [consumed('port', '3000', 1000)]],
    // already consumed the new value — must NOT be flagged
    ['fresh', [consumed('api base', '/v3', 1500)]]
  ])
  const facts = [fact({ id: 'f1', text: 'API base is /v3', ts: 2000 })]
  const hits = computeStale(ledger, facts)
  const nodeIds = hits.map((h) => h.nodeId).sort()
  assert.deepEqual(nodeIds, ['old1', 'old2'])
})

test('a fact with no concrete value is omitted (cannot supersede)', () => {
  // "we should revisit the api base" has the subject but no concrete value.
  assert.equal(consumedFromFact(fact({ id: 'f', text: 'we should revisit the api base later' })), null)
  const ledger: Ledger = new Map([['nodeX', [consumed('api base', '/v2', 1000)]]])
  const facts = [fact({ id: 'f1', text: 'we should revisit the api base later', ts: 2000 })]
  assert.deepEqual(computeStale(ledger, facts), [])
})

test('recency guard: a value asserted BEFORE consumption does not supersede', () => {
  const ledger: Ledger = new Map([['nodeX', [consumed('api base', '/v2', 3000)]]])
  // the /v3 fact is OLDER than when nodeX consumed /v2 — not a supersession.
  const facts = [fact({ id: 'f1', text: 'API base is /v3', ts: 1000 })]
  assert.deepEqual(computeStale(ledger, facts), [])
})

test('dedup: one hit per (node, subject) using the latest consumption', () => {
  const ledger: Ledger = new Map([
    ['nodeX', [consumed('api base', '/v1', 900), consumed('api base', '/v2', 1000)]]
  ])
  const facts = [fact({ id: 'f1', text: 'API base is /v3', ts: 2000 })]
  const hits = computeStale(ledger, facts)
  assert.equal(hits.length, 1)
  // the LATEST consumed value (/v2) is the one reported as stale.
  assert.equal(hits[0].oldValue, '/v2')
})

test('node re-consumed the corrected value -> no longer stale', () => {
  const ledger: Ledger = new Map([
    ['nodeX', [consumed('api base', '/v2', 1000), consumed('api base', '/v3', 2500)]]
  ])
  const facts = [fact({ id: 'f1', text: 'API base is /v3', ts: 2000 })]
  assert.deepEqual(computeStale(ledger, facts), [])
})

test('empty ledger / empty board produce no hits', () => {
  assert.deepEqual(computeStale(new Map(), [fact({ id: 'f', text: 'API base is /v3' })]), [])
  assert.deepEqual(computeStale(new Map([['n', [consumed('port', '3000', 1)]]]), []), [])
})

test('multiple subjects on one node both flagged independently', () => {
  const ledger: Ledger = new Map([
    ['nodeX', [consumed('api base', '/v2', 1000), consumed('port', '3000', 1000)]]
  ])
  const facts = [
    fact({ id: 'f1', text: 'API base is /v3', ts: 2000 }),
    fact({ id: 'f2', text: 'the port is 4000', ts: 2000 })
  ]
  const hits = computeStale(ledger, facts)
  assert.equal(hits.length, 2)
  // sorted by subject within a node: 'api base' before 'port'
  assert.equal(hits[0].subject, 'api base')
  assert.equal(hits[1].subject, 'port')
})

test('formatCorrection is a single terminal-safe Spanish line', () => {
  const line = formatCorrection({ nodeId: 'n', subject: 'api base', oldValue: '/v2', newValue: '/v3' })
  assert.ok(!line.includes('\n'))
  assert.ok(line.includes('/v2'))
  assert.ok(line.includes('/v3'))
  assert.ok(line.includes('api base'))
})

test('hitKey is stable and distinguishes new values', () => {
  const a = hitKey({ nodeId: 'n', subject: 'api base', newValue: '/v3' })
  const b = hitKey({ nodeId: 'n', subject: 'api base', newValue: '/v4' })
  assert.notEqual(a, b)
  assert.equal(a, hitKey({ nodeId: 'n', subject: 'api base', newValue: '/v3' }))
})
