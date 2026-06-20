// recallMatch.test.ts
//
// PURE unit tests for the Recall relevance matcher + injection formatter
// (lib/recallMatch.ts). No DOM, no stores, no IPC — every function takes plain
// data and returns plain data, so these run under `node --test` (with a TS
// loader) or vitest, mirroring consensus.test.ts / objective.test.ts. They lock:
// subject-driven relevance, token-overlap relevance, the precision guard (an
// unrelated memory scores 0 and is dropped), the top-N cap, and the terminal-safe
// single-line block (no embedded newline, ' · ' join, "Lo que ya sabemos:" prefix).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { matchRecall, recallBlock, type RecallFactLike } from './recallMatch'

/** Minimal structural RecallFact for the tests (matches store/recall.ts shape). */
function fact(over: Partial<RecallFactLike> & { text: string }): RecallFactLike {
  return { ...over }
}

// ---- matchRecall: subject relevance ----------------------------------------

test('matchRecall: surfaces a fact whose subject matches the spawn task', () => {
  const facts = [
    fact({ text: 'auth is a bearer token', subject: 'auth', value: 'bearer', agent: 'Atlas' }),
    fact({ text: 'the server runs on port 3000', subject: 'port', value: '3000' })
  ]
  const matched = matchRecall(facts, 'add a login flow, remember auth uses a bearer token')
  assert.ok(matched.length >= 1)
  assert.equal(matched[0].text, 'auth is a bearer token')
})

test('matchRecall: derives subject from text when fact.subject is absent', () => {
  const facts = [fact({ text: 'the API base is /v2', agent: 'Nova' })]
  const matched = matchRecall(facts, 'wire up the API base url for the new client')
  assert.equal(matched.length, 1)
  assert.equal(matched[0].text, 'the API base is /v2')
})

// ---- matchRecall: token-overlap relevance ----------------------------------

test('matchRecall: ranks a token-overlapping fact above an unrelated one', () => {
  const facts = [
    fact({ text: 'the migration script lives in scripts/migrate.mjs' }),
    fact({ text: 'completely unrelated note about coffee' })
  ]
  const matched = matchRecall(facts, 'run the migration script before deploy')
  assert.equal(matched[0].text, 'the migration script lives in scripts/migrate.mjs')
})

// ---- matchRecall: precision guard ------------------------------------------

test('matchRecall: drops facts with no subject match and no token overlap', () => {
  const facts = [fact({ text: 'auth is a bearer token', subject: 'auth' })]
  const matched = matchRecall(facts, 'paint the homepage hero gradient purple')
  assert.deepEqual(matched, [])
})

test('matchRecall: empty memory or empty task -> no matches', () => {
  assert.deepEqual(matchRecall([], 'do something'), [])
  assert.deepEqual(matchRecall([fact({ text: 'auth is a bearer token' })], ''), [])
})

// ---- matchRecall: top-N cap ------------------------------------------------

test('matchRecall: caps results to the requested limit', () => {
  const facts: RecallFactLike[] = []
  for (let i = 0; i < 12; i++) facts.push(fact({ text: `the deploy step number ${i} runs deploy` }))
  const matched = matchRecall(facts, 'run the deploy step', 3)
  assert.equal(matched.length, 3)
})

// ---- recallBlock -----------------------------------------------------------

test('recallBlock: single line, attributed, "Lo que ya sabemos:" prefix', () => {
  const block = recallBlock([
    fact({ text: 'auth is a bearer token', sourceTitle: 'Atlas' }),
    fact({ text: 'the API base is /v2', agent: 'Nova' })
  ])
  assert.ok(!block.includes('\n'))
  assert.ok(block.startsWith('Lo que ya sabemos:'))
  assert.ok(block.includes('[Atlas] auth is a bearer token'))
  assert.ok(block.includes('[Nova] the API base is /v2'))
  assert.ok(block.includes(' · '))
})

test('recallBlock: omits attribution when neither title nor agent is known', () => {
  const block = recallBlock([fact({ text: 'tests pass on the queue worker' })])
  assert.equal(block, 'Lo que ya sabemos: tests pass on the queue worker')
})

test('recallBlock: empty input returns empty string (caller skips delivery)', () => {
  assert.equal(recallBlock([]), '')
  assert.equal(recallBlock([fact({ text: '   ' })]), '')
})
