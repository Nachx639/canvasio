// horizon.test.ts
//
// PURE unit tests for the Mission Horizon forecaster (lib/horizon.ts). No DOM, no
// stores, no IPC — computeHorizon() takes plain data and returns a deterministic
// forecast, so these run under `node --test` (with a TS loader) or vitest. They
// lock: no-goal / no-bearing-agents → idle; no velocity sample → etaMs null; a fully
// met mission → 100% with no gating; the gating agent is the lowest-percent
// INCOMPLETE on-critical agent; critical weighting biases the aggregate; and the
// etaLabel / horizonColor helpers.
//
// We build HorizonInput-shaped objects with LOCAL helpers so this test imports ONLY
// from ./horizon (the ObjectiveJudgment type is structural here), keeping it
// self-contained.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  computeHorizon,
  etaLabel,
  horizonColor,
  type HorizonInput,
  type HorizonAgent
} from './horizon'
import { useI18n } from '../store/i18n'

// horizon.ts now renders headlines via i18n t(); pin the locale so these
// Spanish copy assertions are deterministic regardless of the app default (en).
useI18n.setState({ lang: 'es' })

function agent(over: Partial<HorizonAgent> & { nodeId: string }): HorizonAgent {
  return {
    title: over.nodeId,
    percent: 0,
    judgment: 'on-track',
    onCritical: false,
    hasObjective: true,
    ...over
  }
}

function input(over: Partial<HorizonInput> = {}): HorizonInput {
  return {
    goal: 'enviar el lanzamiento',
    agents: [],
    finishedDurationsMs: [],
    now: 1000,
    ...over
  }
}

// ---- idle states ------------------------------------------------------------

test('computeHorizon: no goal → idle', () => {
  const f = computeHorizon(input({ goal: '' }))
  assert.equal(f.idle, true)
  assert.equal(f.etaMs, null)
  assert.equal(f.gatingNodeId, null)
  assert.equal(f.percent, 0)
  assert.match(f.headline, /sin objetivo/)
})

test('computeHorizon: a goal but no objective-bearing agents → idle', () => {
  const f = computeHorizon(
    input({ agents: [agent({ nodeId: 'a', hasObjective: false, percent: 50 })] })
  )
  assert.equal(f.idle, true)
  assert.equal(f.percent, 0)
  // goal is echoed back even when idle.
  assert.equal(f.goal, 'enviar el lanzamiento')
})

// ---- aggregate % ------------------------------------------------------------

test('computeHorizon: aggregate % is the mean of bearing agents (no weighting)', () => {
  const f = computeHorizon(
    input({
      agents: [
        agent({ nodeId: 'a', percent: 40 }),
        agent({ nodeId: 'b', percent: 80 })
      ]
    })
  )
  assert.equal(f.idle, false)
  assert.equal(f.percent, 60)
  assert.equal(f.contributing, 2)
})

test('computeHorizon: non-objective agents are excluded from the aggregate', () => {
  const f = computeHorizon(
    input({
      agents: [
        agent({ nodeId: 'a', percent: 100 }),
        agent({ nodeId: 'b', percent: 0, hasObjective: false }) // ignored
      ]
    })
  )
  assert.equal(f.percent, 100)
  assert.equal(f.contributing, 1)
})

test('computeHorizon: on-critical agents are weighted 2x in the aggregate', () => {
  // a=0% on-critical (weight 2), b=90% normal (weight 1) → (0*2 + 90*1)/3 = 30.
  const f = computeHorizon(
    input({
      agents: [
        agent({ nodeId: 'a', percent: 0, onCritical: true }),
        agent({ nodeId: 'b', percent: 90 })
      ]
    })
  )
  assert.equal(f.percent, 30)
})

// ---- ETA / velocity ---------------------------------------------------------

test('computeHorizon: no velocity sample → etaMs null', () => {
  const f = computeHorizon(
    input({ agents: [agent({ nodeId: 'a', percent: 20 })], finishedDurationsMs: [] })
  )
  assert.equal(f.etaMs, null)
  // headline still reads a percent, just no ETA token.
  assert.match(f.headline, /^20%/)
})

test('computeHorizon: ETA = median task ms × remaining agent-tasks', () => {
  // one agent at 50% → 0.5 remaining tasks; median velocity 120000ms → eta 60000ms.
  const f = computeHorizon(
    input({
      agents: [agent({ nodeId: 'a', percent: 50 })],
      finishedDurationsMs: [120000]
    })
  )
  assert.equal(f.etaMs, 60000)
  assert.match(f.headline, /~1m/)
})

test('computeHorizon: median ignores zero/negative samples', () => {
  const f = computeHorizon(
    input({
      agents: [agent({ nodeId: 'a', percent: 0 })],
      finishedDurationsMs: [0, -5, 30000, 90000]
    })
  )
  // median of [30000, 90000] = 60000; remaining 1.0 → eta 60000.
  assert.equal(f.etaMs, 60000)
})

// ---- fully met --------------------------------------------------------------

test('computeHorizon: every agent met → 100%, no ETA, no gating', () => {
  const f = computeHorizon(
    input({
      agents: [
        agent({ nodeId: 'a', percent: 100, judgment: 'met', onCritical: true }),
        agent({ nodeId: 'b', percent: 100, judgment: 'met' })
      ],
      finishedDurationsMs: [60000]
    })
  )
  assert.equal(f.percent, 100)
  assert.equal(f.etaMs, null) // nothing remains
  assert.equal(f.gatingNodeId, null)
  assert.match(f.headline, /misión cumplida/)
})

// ---- gating agent -----------------------------------------------------------

test('computeHorizon: gating is the lowest-percent INCOMPLETE on-critical agent', () => {
  const f = computeHorizon(
    input({
      agents: [
        agent({ nodeId: 'a', title: 'Atlas', percent: 70, onCritical: true }),
        agent({ nodeId: 'm', title: 'Atlas', percent: 20, onCritical: true }),
        agent({ nodeId: 'z', title: 'Vega', percent: 5 }) // lower, but NOT on critical
      ]
    })
  )
  assert.equal(f.gatingNodeId, 'm')
  assert.equal(f.gatingTitle, 'Atlas')
  assert.match(f.headline, /falta Atlas/)
})

test('computeHorizon: a met on-critical agent never gates', () => {
  const f = computeHorizon(
    input({
      agents: [
        agent({ nodeId: 'done', percent: 100, judgment: 'met', onCritical: true }),
        agent({ nodeId: 'live', title: 'Iris', percent: 60, onCritical: true })
      ]
    })
  )
  assert.equal(f.gatingNodeId, 'live')
})

test('computeHorizon: no on-critical incomplete agent → no gating', () => {
  const f = computeHorizon(
    input({ agents: [agent({ nodeId: 'a', percent: 30, onCritical: false })] })
  )
  assert.equal(f.gatingNodeId, null)
  assert.equal(f.gatingTitle, null)
})

test('computeHorizon: gating ties break by nodeId asc (deterministic)', () => {
  const f = computeHorizon(
    input({
      agents: [
        agent({ nodeId: 'b', percent: 10, onCritical: true }),
        agent({ nodeId: 'a', percent: 10, onCritical: true })
      ]
    })
  )
  assert.equal(f.gatingNodeId, 'a')
})

// ---- helpers ----------------------------------------------------------------

test('etaLabel: formats seconds / minutes / hours', () => {
  assert.equal(etaLabel(null), '—')
  assert.equal(etaLabel(0), '—')
  assert.equal(etaLabel(45000), '45s')
  assert.equal(etaLabel(7 * 60000), '7m')
  assert.equal(etaLabel(72 * 60000), '1h12m')
  assert.equal(etaLabel(60 * 60000), '1h')
})

test('horizonColor: idle muted, done green, low-with-gating amber, else calm blue', () => {
  assert.equal(horizonColor(computeHorizon(input({ goal: '' }))), '#5b6887')
  assert.equal(
    horizonColor(
      computeHorizon(input({ agents: [agent({ nodeId: 'a', percent: 100, judgment: 'met' })] }))
    ),
    '#48d597'
  )
  assert.equal(
    horizonColor(
      computeHorizon(
        input({ agents: [agent({ nodeId: 'a', percent: 10, onCritical: true })] })
      )
    ),
    '#f2c84b'
  )
  assert.equal(
    horizonColor(
      computeHorizon(input({ agents: [agent({ nodeId: 'a', percent: 75 })] }))
    ),
    '#7aa2ff'
  )
})
