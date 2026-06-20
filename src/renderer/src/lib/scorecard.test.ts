// scorecard.test.ts
//
// PURE unit tests for the Agent Scorecard ranker (lib/scorecard.ts). No DOM, no
// stores, no IPC — computeScorecard() / recommendBetterKind() take plain AgentStat
// fixtures and return deterministic results, so these run under `node --test`
// (with a TS loader), matching the existing conductor.test.ts convention.
//
// They lock the load-bearing guarantees:
//   - empty stats → all four personas present, all 'insufficient', no winner,
//   - evidence outranks insufficient data (precision over recall),
//   - a clearly-more-reliable persona wins the ranking,
//   - recommendBetterKind() returns a decisive winner, and null when none.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  computeScorecard,
  recommendBetterKind,
  reliabilityFor,
  emptyStat,
  AGENT_KINDS,
  MIN_SAMPLES,
  type AgentStat
} from './scorecard'

function stat(over: Partial<AgentStat> & { kind: AgentStat['kind'] }): AgentStat {
  return { done: 0, error: 0, stall: 0, medianDoneMs: 0, ...over }
}

// ---- empty ------------------------------------------------------------------

test('computeScorecard: empty stats → all four personas, all insufficient', () => {
  const sc = computeScorecard([])
  assert.equal(sc.ranked.length, AGENT_KINDS.length)
  assert.ok(sc.ranked.every((r) => r.insufficient))
  assert.ok(sc.ranked.every((r) => r.samples === 0))
  // byKind covers every persona.
  for (const k of AGENT_KINDS) assert.ok(sc.byKind[k])
})

test('emptyStat: zeroed stat for a kind', () => {
  assert.deepEqual(emptyStat('claude'), {
    kind: 'claude',
    done: 0,
    error: 0,
    stall: 0,
    medianDoneMs: 0
  })
})

// ---- evidence outranks insufficient -----------------------------------------

test('computeScorecard: a persona with evidence ranks above an unproven one', () => {
  // codex has 1 sample (insufficient); claude has plenty.
  const sc = computeScorecard([
    stat({ kind: 'claude', done: 10, error: 0, medianDoneMs: 1000 }),
    stat({ kind: 'codex', done: 1, error: 0 })
  ])
  // claude (evidence) must come before codex (insufficient) regardless of rate.
  const claudeIdx = sc.ranked.findIndex((r) => r.kind === 'claude')
  const codexIdx = sc.ranked.findIndex((r) => r.kind === 'codex')
  assert.ok(claudeIdx < codexIdx)
  assert.equal(sc.byKind['claude'].insufficient, false)
  assert.equal(sc.byKind['codex'].insufficient, true)
})

test('computeScorecard: insufficient threshold is MIN_SAMPLES', () => {
  const below = computeScorecard([stat({ kind: 'claude', done: MIN_SAMPLES - 1 })])
  assert.equal(below.byKind['claude'].insufficient, true)
  const at = computeScorecard([stat({ kind: 'claude', done: MIN_SAMPLES })])
  assert.equal(at.byKind['claude'].insufficient, false)
})

// ---- reliable wins ----------------------------------------------------------

test('computeScorecard: a reliable persona outranks an erroring one', () => {
  const sc = computeScorecard([
    stat({ kind: 'claude', done: 9, error: 1, medianDoneMs: 1000 }),
    stat({ kind: 'codex', done: 3, error: 7, medianDoneMs: 1000 })
  ])
  assert.equal(sc.ranked[0].kind, 'claude')
  assert.ok(sc.byKind['claude'].score > sc.byKind['codex'].score)
  assert.ok(sc.byKind['claude'].successRate > sc.byKind['codex'].successRate)
})

test('computeScorecard: speed nudge cannot flip a reliability ordering', () => {
  // codex is faster but far less reliable — claude must still win.
  const sc = computeScorecard([
    stat({ kind: 'claude', done: 9, error: 1, medianDoneMs: 5000 }),
    stat({ kind: 'codex', done: 4, error: 6, medianDoneMs: 100 })
  ])
  assert.equal(sc.ranked[0].kind, 'claude')
})

// ---- recommendBetterKind ----------------------------------------------------

test('recommendBetterKind: returns a decisively better persona', () => {
  const sc = computeScorecard([
    stat({ kind: 'claude', done: 18, error: 2, medianDoneMs: 1000 }), // 0.9 rate
    stat({ kind: 'codex', done: 5, error: 15, medianDoneMs: 1000 }) // 0.25 rate
  ])
  const better = recommendBetterKind('codex', sc)
  assert.ok(better)
  assert.equal(better?.kind, 'claude')
})

test('recommendBetterKind: null when no decisive winner', () => {
  // two equally-good personas — neither clears the decisive gap.
  const sc = computeScorecard([
    stat({ kind: 'claude', done: 9, error: 1, medianDoneMs: 1000 }),
    stat({ kind: 'codex', done: 9, error: 1, medianDoneMs: 1000 })
  ])
  assert.equal(recommendBetterKind('codex', sc), null)
})

test('recommendBetterKind: never recommends an unproven persona', () => {
  // claude looks perfect but has too few samples → must NOT be recommended.
  const sc = computeScorecard([
    stat({ kind: 'claude', done: 2, error: 0 }), // insufficient
    stat({ kind: 'codex', done: 3, error: 7, medianDoneMs: 1000 })
  ])
  assert.equal(recommendBetterKind('codex', sc), null)
})

test('recommendBetterKind: null for the already-best persona', () => {
  const sc = computeScorecard([
    stat({ kind: 'claude', done: 18, error: 2, medianDoneMs: 1000 }),
    stat({ kind: 'codex', done: 5, error: 15, medianDoneMs: 1000 })
  ])
  assert.equal(recommendBetterKind('claude', sc), null)
})

// ---- reliabilityFor ---------------------------------------------------------

test('reliabilityFor: defensive default for an unknown scorecard', () => {
  const sc = computeScorecard([])
  const row = reliabilityFor('shell', sc)
  assert.equal(row.kind, 'shell')
  assert.equal(row.insufficient, true)
})
