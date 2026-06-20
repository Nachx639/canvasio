// objective.test.ts
//
// PURE unit tests for assessObjective (lib/objective.ts). No DOM, no stores, no
// IPC — assessObjective takes plain data and returns a deterministic reading, so
// these run under `node --test` (with a TS loader) or vitest. They cover:
// checklist ticking, drift detection, "met", idle, Spanish/English done-signals,
// and the checklist-free activity floor.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  assessObjective,
  objectiveTextFromPrompt,
  type ObjectiveInput
} from './objective'
import type { MissionEvent } from '../store/mission'

/** Build a minimal mission event for a node. */
function ev(kind: MissionEvent['kind'], over: Partial<MissionEvent> = {}): MissionEvent {
  return {
    id: Math.random().toString(36).slice(2),
    ts: 1000,
    nodeId: 'n1',
    title: 'Atlas',
    kind,
    ...over
  }
}

/** Base input with sensible empties; override per test. */
function input(over: Partial<ObjectiveInput>): ObjectiveInput {
  return {
    objective: undefined,
    status: 'idle',
    echoLines: [],
    events: [],
    now: 5000,
    ...over
  }
}

test('idle when no objective is set', () => {
  const r = assessObjective(input({ objective: undefined, status: 'working' }))
  assert.equal(r.judgment, 'idle')
  assert.equal(r.percent, 0)
  assert.equal(r.met, false)
})

test('idle when objective set but no activity at all', () => {
  const r = assessObjective(
    input({ objective: { text: 'ship the login form' }, status: 'idle' })
  )
  assert.equal(r.judgment, 'idle')
  assert.equal(r.percent, 0)
})

test('checklist item auto-ticks on matching keywords in output (English)', () => {
  const r = assessObjective(
    input({
      objective: { text: 'green build', checklist: [{ label: 'tests pass', done: false }] },
      status: 'working',
      echoLines: ['running 142 tests', 'all 142 tests pass']
    })
  )
  assert.deepEqual(r.ticked, [true])
  assert.equal(r.percent, 100)
  assert.equal(r.judgment, 'met')
  assert.equal(r.met, true)
})

test('checklist item auto-ticks on Spanish done-signal keywords', () => {
  const r = assessObjective(
    input({
      objective: {
        text: 'arreglar el build',
        checklist: [{ label: 'pruebas pasan', done: false }]
      },
      status: 'working',
      echoLines: ['ejecutando pruebas', 'las pruebas pasan correctamente']
    })
  )
  assert.deepEqual(r.ticked, [true])
  assert.equal(r.judgment, 'met')
})

test('partial checklist → partial percent, on-track (not met)', () => {
  const r = assessObjective(
    input({
      objective: {
        text: 'ship feature',
        checklist: [
          { label: 'tests pass', done: false },
          { label: 'commit pushed', done: false }
        ]
      },
      status: 'working',
      echoLines: ['all tests pass now']
    })
  )
  assert.deepEqual(r.ticked, [true, false])
  assert.equal(r.percent, 50)
  assert.equal(r.met, false)
  assert.notEqual(r.judgment, 'met')
})

test('manual done flag ticks an item even without output signal', () => {
  const r = assessObjective(
    input({
      objective: { text: 'x', checklist: [{ label: 'reviewed by hand', done: true }] },
      status: 'working',
      echoLines: ['some unrelated line']
    })
  )
  assert.deepEqual(r.ticked, [true])
  assert.equal(r.judgment, 'met')
})

test('drifting: busy with output but no objective signal', () => {
  const r = assessObjective(
    input({
      objective: { text: 'fix the auth bug', checklist: [{ label: 'auth bug fixed', done: false }] },
      status: 'working',
      echoLines: [
        'reading some other file',
        'scrolling through logs',
        'thinking about lunch',
        'opening unrelated module',
        'more chatter here'
      ],
      diff: { files: 3, adds: 40, dels: 5 }
    })
  )
  assert.equal(r.judgment, 'drifting')
  assert.equal(r.met, false)
})

test('not drifting when there is a recent objective signal', () => {
  const r = assessObjective(
    input({
      objective: { text: 'fix the auth bug', checklist: [{ label: 'auth fixed', done: false }] },
      status: 'working',
      echoLines: [
        'reading some other file',
        'scrolling through logs',
        'the auth fixed and verified'
      ]
    })
  )
  assert.notEqual(r.judgment, 'drifting')
  assert.deepEqual(r.ticked, [true])
})

test('checklist-free objective moves on activity floor (completions + churn)', () => {
  const r = assessObjective(
    input({
      objective: { text: 'refactor the parser' },
      status: 'working',
      events: [ev('done', { durationMs: 5000 })],
      diff: { files: 2, adds: 30, dels: 10 },
      echoLines: ['editing parser.ts', 'refactoring helpers']
    })
  )
  // completions(1)*25 + churn(20) + working(10) = 55, capped at 80
  assert.ok(r.percent >= 50 && r.percent < 100, `percent was ${r.percent}`)
  assert.equal(r.met, false)
})

test('checklist-free objective met on a strong done-signal', () => {
  const r = assessObjective(
    input({
      objective: { text: 'push the fix' },
      status: 'working',
      echoLines: ['committing changes', 'pushed to origin/main']
    })
  )
  assert.equal(r.met, true)
  assert.equal(r.percent, 100)
  assert.equal(r.judgment, 'met')
})

test('error state suppresses a checklist-free "met"', () => {
  const r = assessObjective(
    input({
      objective: { text: 'build it' },
      status: 'error',
      echoLines: ['done compiling', 'error TS2304: cannot find name']
    })
  )
  assert.equal(r.met, false)
  assert.notEqual(r.judgment, 'met')
})

test('objectiveTextFromPrompt truncates and takes first sentence', () => {
  assert.equal(objectiveTextFromPrompt('  Ship the login form.  Then deploy.  '), 'Ship the login form.')
  const long = 'a'.repeat(200)
  assert.ok(objectiveTextFromPrompt(long).length <= 90)
  assert.equal(objectiveTextFromPrompt('   '), '')
})
