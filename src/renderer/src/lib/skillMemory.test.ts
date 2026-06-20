// skillMemory.test.ts
//
// PURE unit tests for Skill Memory (lib/skillMemory.ts). No DOM, no stores, no IPC —
// classifyTask() / rankForBucket() / bestForBucket() take plain text + table
// fixtures and return deterministic results, so these run under `node --test` (with
// a TS loader), matching the existing scorecard.test.ts / conductor.test.ts
// convention.
//
// They lock the load-bearing guarantees:
//   - the classifier hits its EN + ES vocabulary per bucket,
//   - unmatched / empty text falls back to 'other' (precision over recall),
//   - bucket priority ordering is honored on overlapping signals,
//   - bestForBucket() returns a decisive winner ONLY with real evidence, and never
//     for the catch-all 'other' bucket.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  classifyTask,
  bestForBucket,
  rankForBucket,
  emptySkillTable,
  SKILL_BUCKETS
} from './skillMemory'
import { MIN_SAMPLES } from './scorecard'

// ---- classifier: EN hits -----------------------------------------------------

test('classifyTask: English keywords map to the right bucket', () => {
  assert.equal(classifyTask('Fix the failing jest test for the parser'), 'tests')
  assert.equal(classifyTask('Design the architecture for the new schema'), 'design')
  assert.equal(classifyTask('Refactor and cleanup the legacy module'), 'refactor')
  assert.equal(classifyTask('Update the README docs with examples'), 'docs')
  assert.equal(classifyTask('Fix the CI build and deploy the release'), 'build')
  assert.equal(classifyTask('Review and audit the security of this PR'), 'review')
})

// ---- classifier: ES hits -----------------------------------------------------

test('classifyTask: Spanish keywords map to the right bucket', () => {
  assert.equal(classifyTask('Arregla la prueba que falla en el parser'), 'tests')
  assert.equal(classifyTask('Diseña la arquitectura del nuevo esquema'), 'design')
  assert.equal(classifyTask('Reescribe y limpia el módulo antiguo'), 'refactor')
  assert.equal(classifyTask('Documenta el readme y añade comentarios'), 'docs')
  assert.equal(classifyTask('Compila y despliega el lanzamiento'), 'build')
  assert.equal(classifyTask('Revisa y audita este cambio'), 'review')
})

// ---- classifier: 'other' fallback -------------------------------------------

test('classifyTask: unmatched / empty text → other (precision over recall)', () => {
  assert.equal(classifyTask('do the thing with the colorful widget'), 'other')
  assert.equal(classifyTask(''), 'other')
  assert.equal(classifyTask('   '), 'other')
  assert.equal(classifyTask(undefined), 'other')
  assert.equal(classifyTask(null), 'other')
})

// ---- classifier: priority ordering ------------------------------------------

test('classifyTask: tests outranks refactor on overlapping signal', () => {
  // Both 'test' and 'refactor' appear; tests is earlier in the priority order.
  assert.equal(classifyTask('Refactor the test helpers'), 'tests')
})

// ---- ranking: precision over recall (thin evidence) -------------------------

test('bestForBucket: no winner under MIN_SAMPLES', () => {
  const table = emptySkillTable()
  // Give codex only 2 completions in 'tests' — below MIN_SAMPLES (4).
  table.tests.codex = { done: 2, error: 0 }
  assert.ok(MIN_SAMPLES > 2) // guards the premise of this test
  assert.equal(bestForBucket('tests', table), null)
})

test('bestForBucket: decisive winner with real evidence', () => {
  const table = emptySkillTable()
  table.tests.codex = { done: 5, error: 0 }
  table.tests.claude = { done: 1, error: 3 }
  const best = bestForBucket('tests', table)
  assert.ok(best)
  assert.equal(best?.kind, 'codex')
  assert.equal(best?.samples, 5)
})

test('bestForBucket: the catch-all other bucket never produces a winner', () => {
  const table = emptySkillTable()
  table.other.claude = { done: 99, error: 0 }
  assert.equal(bestForBucket('other', table), null)
})

// ---- ranking: covers all personas + buckets ---------------------------------

test('rankForBucket: always ranks all four personas', () => {
  const table = emptySkillTable()
  const sc = rankForBucket('design', table)
  assert.equal(sc.ranked.length, 4)
  assert.ok(sc.ranked.every((r) => r.insufficient))
})

test('SKILL_BUCKETS: includes the catch-all and the six real buckets', () => {
  assert.ok(SKILL_BUCKETS.includes('other'))
  assert.equal(SKILL_BUCKETS.length, 7)
})
