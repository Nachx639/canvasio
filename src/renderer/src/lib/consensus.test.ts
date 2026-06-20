// consensus.test.ts
//
// PURE unit tests for the Consensus Lens classifier (lib/consensus.ts). No DOM,
// no stores, no IPC — every function takes plain data and returns plain data, so
// these run under `node --test` (with a TS loader, or Node's native type
// stripping) or vitest. They lock corroboration, contradiction, the single-agent
// self-revision guard, verdict conflicts, and the precision guards (unknown
// subject / no value -> ignored, never an invented conflict).
//
// We build BoardFact-shaped objects with a LOCAL helper so this test imports
// ONLY from ./consensus (the BoardFact type is structural here), keeping it
// self-contained and runnable without resolving the zustand store module.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  subjectKey,
  assertedValue,
  analyzeConsensus,
  formatReconcilePrompt
} from './consensus'

/** Minimal structural BoardFact for the tests (matches store/board.ts shape). */
function fact(over: {
  id: string
  text: string
  agent?: string
  sourceTitle?: string
}): { id: string; ts: number; text: string; agent?: string; sourceTitle?: string } {
  return { ts: Date.now(), ...over }
}

// ---- subjectKey ------------------------------------------------------------

test('subjectKey: classifies known subjects', () => {
  assert.equal(subjectKey('auth is a bearer token'), 'auth')
  assert.equal(subjectKey('the API base is /v2'), 'api base')
  assert.equal(subjectKey('we are using Postgres for the queue'), 'db')
  assert.equal(subjectKey('the server runs on port 3000'), 'port')
  assert.equal(subjectKey('the login endpoint is /login'), 'endpoint')
})

test('subjectKey: verdict lines map to the verdict subject', () => {
  assert.equal(subjectKey('all 12 tests pass'), 'verdict')
  assert.equal(subjectKey('build failed'), 'verdict')
})

test('subjectKey: unknown subject returns null (precision guard)', () => {
  assert.equal(subjectKey('this is looking great so far'), null)
  assert.equal(subjectKey(''), null)
})

// ---- assertedValue ---------------------------------------------------------

test('assertedValue: extracts normalized values per subject', () => {
  assert.equal(assertedValue('auth is a bearer token', 'auth'), 'bearer')
  assert.equal(assertedValue('auth uses an API key', 'auth'), 'apikey')
  assert.equal(assertedValue('the API base is /v2', 'api base'), '/v2')
  assert.equal(assertedValue('using Postgres', 'db'), 'postgres')
  assert.equal(assertedValue('runs on port 3000', 'port'), '3000')
})

test('assertedValue: no concrete value -> empty string (omitted by caller)', () => {
  assert.equal(assertedValue('auth is important', 'auth'), '')
})

// ---- analyzeConsensus: corroboration ---------------------------------------

test('corroboration: two agents, same auth value -> corroborated, no conflict', () => {
  const facts = [
    fact({ id: 'f1', text: 'auth is a bearer token', agent: 'Atlas' }),
    fact({ id: 'f2', text: 'auth uses a bearer token', agent: 'Nova' })
  ]
  const r = analyzeConsensus(facts)
  assert.equal(r.conflicts.length, 0)
  assert.equal(r.corroborated.length, 1)
  const c = r.corroborated[0]
  assert.equal(c.subject, 'auth')
  assert.equal(c.value, 'bearer')
  assert.deepEqual(c.agents.sort(), ['Atlas', 'Nova'])
  assert.deepEqual(c.factIds.sort(), ['f1', 'f2'])
})

// ---- analyzeConsensus: contradiction ---------------------------------------

test('contradiction: two agents, different auth value -> one conflict', () => {
  const facts = [
    fact({ id: 'f1', text: 'auth is a bearer token', agent: 'Atlas' }),
    fact({ id: 'f2', text: 'auth uses an API key', agent: 'Nova' })
  ]
  const r = analyzeConsensus(facts)
  assert.equal(r.corroborated.length, 0)
  assert.equal(r.conflicts.length, 1)
  const k = r.conflicts[0]
  assert.equal(k.subject, 'auth')
  assert.equal(k.claims.length, 2)
  const byAgent = Object.fromEntries(k.claims.map((c) => [c.agent, c.value]))
  assert.equal(byAgent['Atlas'], 'bearer')
  assert.equal(byAgent['Nova'], 'apikey')
})

// ---- single-agent self-revision is NOT a conflict --------------------------

test('self-revision: one agent asserting two values is NOT a conflict', () => {
  const facts = [
    fact({ id: 'f1', text: 'auth is a bearer token', agent: 'Atlas' }),
    fact({ id: 'f2', text: 'actually auth uses an API key', agent: 'Atlas' })
  ]
  const r = analyzeConsensus(facts)
  assert.equal(r.conflicts.length, 0)
  assert.equal(r.corroborated.length, 0)
})

// ---- verdict conflict ------------------------------------------------------

test('verdict conflict: tests pass vs build failed across agents', () => {
  const facts = [
    fact({ id: 'f1', text: 'all 12 tests pass', sourceTitle: 'Atlas' }),
    fact({ id: 'f2', text: 'build failed', sourceTitle: 'Nova' })
  ]
  const r = analyzeConsensus(facts)
  assert.equal(r.conflicts.length, 1)
  assert.equal(r.conflicts[0].subject, 'verdict')
  const values = r.conflicts[0].claims.map((c) => c.value).sort()
  assert.deepEqual(values, ['fail', 'pass'])
})

test('verdict corroboration: two agents both report pass', () => {
  const facts = [
    fact({ id: 'f1', text: 'tests pass', agent: 'Atlas' }),
    fact({ id: 'f2', text: 'build ok', agent: 'Nova' })
  ]
  const r = analyzeConsensus(facts)
  assert.equal(r.conflicts.length, 0)
  assert.equal(r.corroborated.length, 1)
  assert.equal(r.corroborated[0].value, 'pass')
})

// ---- precision guards ------------------------------------------------------

test('precision: unknown subject is ignored (no phantom conflict)', () => {
  const facts = [
    fact({ id: 'f1', text: 'this is going well', agent: 'Atlas' }),
    fact({ id: 'f2', text: 'looking good overall', agent: 'Nova' })
  ]
  assert.deepEqual(analyzeConsensus(facts), { corroborated: [], conflicts: [] })
})

test('precision: a fact with no attribution cannot vote', () => {
  const facts = [
    fact({ id: 'f1', text: 'auth is a bearer token', agent: 'Atlas' }),
    fact({ id: 'f2', text: 'auth uses an API key' }) // no agent/title
  ]
  const r = analyzeConsensus(facts)
  // Only one attributed agent on the subject -> neither corroboration nor conflict.
  assert.equal(r.conflicts.length, 0)
  assert.equal(r.corroborated.length, 0)
})

test('precision: empty board -> empty readout', () => {
  assert.deepEqual(analyzeConsensus([]), { corroborated: [], conflicts: [] })
})

// ---- formatReconcilePrompt -------------------------------------------------

test('formatReconcilePrompt: single line, both claims attributed', () => {
  const prompt = formatReconcilePrompt({
    subject: 'auth',
    claims: [
      { agent: 'Atlas', value: 'bearer', factId: 'f1' },
      { agent: 'Nova', value: 'apikey', factId: 'f2' }
    ]
  })
  assert.ok(!prompt.includes('\n'))
  assert.ok(prompt.includes('Atlas'))
  assert.ok(prompt.includes('Nova'))
  assert.ok(prompt.includes('auth'))
})
