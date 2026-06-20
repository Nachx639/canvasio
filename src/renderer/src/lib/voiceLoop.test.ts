// voiceLoop.test.ts
//
// PURE unit tests for the Voice Standup Loop selection core (lib/voiceLoop.ts). No
// DOM, no stores, no IPC — pickNextQuestion() takes plain data and returns a
// deterministic pick, so these run under `node --test` (with a TS loader) or vitest,
// mirroring stallRescue/missionBrief tests. They lock: the arm→question→pick path,
// the no-pending passthrough (one-at-a-time), live-node gating, resolved/announced
// skipping, and deterministic first-card ordering.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pickNextQuestion, type QuestionLike } from './voiceLoop'

function q(over: Partial<QuestionLike> & { id: string }): QuestionLike {
  return {
    text: 'q?',
    askingNodeId: 'n1',
    askingTitle: 'Iris',
    resolved: false,
    ...over
  }
}

test('picks the first live, unresolved, not-yet-announced question', () => {
  const cards = [q({ id: 'a', askingNodeId: 'n1', askingTitle: 'Iris', text: '¿Postgres o Redis?' })]
  const pick = pickNextQuestion(cards, new Set(['n1']), new Set(), false)
  assert.deepEqual(pick, {
    questionId: 'a',
    targetId: 'n1',
    askingTitle: 'Iris',
    text: '¿Postgres o Redis?'
  })
})

test('one-at-a-time: returns null when a reply is already pending', () => {
  const cards = [q({ id: 'a' })]
  assert.equal(pickNextQuestion(cards, new Set(['n1']), new Set(), true), null)
})

test('skips resolved cards', () => {
  const cards = [q({ id: 'a', resolved: true })]
  assert.equal(pickNextQuestion(cards, new Set(['n1']), new Set(), false), null)
})

test('skips questions whose asking node no longer exists', () => {
  const cards = [q({ id: 'a', askingNodeId: 'gone' })]
  assert.equal(pickNextQuestion(cards, new Set(['n1']), new Set(), false), null)
})

test('skips already-announced cards (no re-voice within a session)', () => {
  const cards = [q({ id: 'a' })]
  assert.equal(pickNextQuestion(cards, new Set(['n1']), new Set(['a']), false), null)
})

test('deterministic: earliest eligible card wins, later eligible ignored this pass', () => {
  const cards = [
    q({ id: 'a', resolved: true }), // skipped
    q({ id: 'b', askingNodeId: 'dead' }), // skipped (no live node)
    q({ id: 'c', askingNodeId: 'n2', askingTitle: 'Nova', text: '¿Qué versión?' }),
    q({ id: 'd', askingNodeId: 'n2', askingTitle: 'Nova', text: 'otra' })
  ]
  const pick = pickNextQuestion(cards, new Set(['n1', 'n2']), new Set(), false)
  assert.equal(pick?.questionId, 'c')
})

test('falls back to a default title when askingTitle is blank', () => {
  const cards = [q({ id: 'a', askingTitle: '   ' })]
  const pick = pickNextQuestion(cards, new Set(['n1']), new Set(), false)
  assert.equal(pick?.askingTitle, 'Un agente')
})
