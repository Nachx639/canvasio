// conductor.test.ts
//
// PURE unit tests for the Conductor reasoner (lib/conductor.ts). No DOM, no
// stores, no IPC — recommend() takes plain data and returns a deterministic ranked
// list, so these run under `node --test` (with a TS loader) or vitest. They lock:
// the empty board → [], error+bottleneck outranking a plain waiting, drift
// surfacing below hard blockers, relay-readiness, conflicts emitted only across
// distinct agents (already guaranteed by ConsensusReadout), and deterministic
// ordering.
//
// We build ConductorInput-shaped objects with LOCAL helpers so this test imports
// ONLY from ./conductor (the CriticalPath / ConsensusReadout types are structural
// here), keeping it self-contained.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  recommend,
  recommendationColor,
  type ConductorInput,
  type AgentSnapshot
} from './conductor'
import type { CriticalPath } from './criticalPath'
import type { ConsensusReadout } from './consensus'
import { useI18n } from '../store/i18n'

// conductor.ts now builds recommendation copy via i18n t(); pin the locale so these
// Spanish assertions are deterministic regardless of the app default (en).
useI18n.setState({ lang: 'es' })

const EMPTY_CRITICAL: CriticalPath = {
  blocked: [],
  bottleneckId: null,
  bottleneckHeld: 0,
  chain: []
}
const EMPTY_CONSENSUS: ConsensusReadout = { corroborated: [], conflicts: [] }

function agent(over: Partial<AgentSnapshot> & { nodeId: string }): AgentSnapshot {
  return {
    title: over.nodeId,
    status: 'working',
    lastTs: 0,
    ...over
  }
}

function input(over: Partial<ConductorInput> = {}): ConductorInput {
  return {
    agents: [],
    critical: EMPTY_CRITICAL,
    consensus: EMPTY_CONSENSUS,
    relayReady: [],
    now: 1000,
    ...over
  }
}

// ---- empty ------------------------------------------------------------------

test('recommend: empty board → []', () => {
  assert.deepEqual(recommend(input()), [])
})

test('recommend: idle/working agents with nothing pending → []', () => {
  const recs = recommend(
    input({
      agents: [
        agent({ nodeId: 'a', status: 'working' }),
        agent({ nodeId: 'b', status: 'idle' })
      ]
    })
  )
  assert.deepEqual(recs, [])
})

// ---- error is the top tier --------------------------------------------------

test('recommend: an errored agent surfaces as resolve-error', () => {
  const recs = recommend(
    input({ agents: [agent({ nodeId: 'a', title: 'Nova', status: 'error' })] })
  )
  assert.equal(recs.length, 1)
  assert.equal(recs[0].kind, 'resolve-error')
  assert.equal(recs[0].nodeId, 'a')
  assert.equal(recs[0].actionKind, 'fly')
})

test('recommend: error+bottleneck outranks a plain waiting agent', () => {
  const recs = recommend(
    input({
      agents: [
        agent({ nodeId: 'err', title: 'Atlas', status: 'error' }),
        agent({ nodeId: 'wait', title: 'Iris', status: 'idle', lastKind: 'waiting' })
      ],
      // Atlas is the critical-path bottleneck → leverage bonus.
      critical: {
        blocked: [{ nodeId: 'wait', waitingOn: ['err'] }],
        bottleneckId: 'err',
        bottleneckHeld: 1,
        chain: ['err', 'wait']
      }
    })
  )
  assert.equal(recs[0].nodeId, 'err')
  assert.equal(recs[0].kind, 'resolve-error')
  // The bottleneck reason calls it out explicitly.
  assert.match(recs[0].reason, /cuello de botella/)
  // The waiting agent is still present, but ranked below.
  assert.ok(recs.some((r) => r.kind === 'unblock-waiting' && r.nodeId === 'wait'))
  assert.ok(recs[0].score > recs[1].score)
})

test('recommend: a bottleneck error outscores a non-bottleneck error', () => {
  const recs = recommend(
    input({
      agents: [
        agent({ nodeId: 'leaf', title: 'Kai', status: 'error' }),
        agent({ nodeId: 'boss', title: 'Atlas', status: 'error' })
      ],
      critical: {
        blocked: [{ nodeId: 'x', waitingOn: ['boss'] }],
        bottleneckId: 'boss',
        bottleneckHeld: 1,
        chain: ['boss', 'x']
      }
    })
  )
  assert.equal(recs[0].nodeId, 'boss')
})

// ---- relay readiness --------------------------------------------------------

test('recommend: a done source with un-fired downstream targets → confirm-relay', () => {
  const recs = recommend(
    input({
      agents: [agent({ nodeId: 's', title: 'Iris', status: 'done', lastKind: 'done' })],
      relayReady: [{ sourceId: 's', waiting: 2 }]
    })
  )
  const relay = recs.find((r) => r.kind === 'confirm-relay')
  assert.ok(relay)
  assert.equal(relay!.nodeId, 's')
  assert.match(relay!.reason, /2 agentes esperan/)
  // The plain service-done recommendation is suppressed when relay-ready.
  assert.ok(!recs.some((r) => r.kind === 'service-done' && r.nodeId === 's'))
})

test('recommend: a done source with no waiting targets → service-done, not confirm-relay', () => {
  const recs = recommend(
    input({
      agents: [agent({ nodeId: 's', title: 'Iris', status: 'done', lastKind: 'done' })],
      relayReady: [{ sourceId: 's', waiting: 0 }]
    })
  )
  assert.ok(!recs.some((r) => r.kind === 'confirm-relay'))
  assert.ok(recs.some((r) => r.kind === 'service-done' && r.nodeId === 's'))
})

// ---- drift surfaces below hard blockers -------------------------------------

test('recommend: drift surfaces below blockers', () => {
  const recs = recommend(
    input({
      agents: [
        agent({ nodeId: 'e', title: 'Nova', status: 'error' }),
        agent({ nodeId: 'd', title: 'Nova', status: 'working', objective: 'drifting' })
      ]
    })
  )
  const errIdx = recs.findIndex((r) => r.kind === 'resolve-error')
  const driftIdx = recs.findIndex((r) => r.kind === 'review-drift')
  assert.ok(errIdx >= 0 && driftIdx >= 0)
  assert.ok(errIdx < driftIdx)
})

test('recommend: drift is NOT re-recommended for an agent already in error', () => {
  const recs = recommend(
    input({
      agents: [agent({ nodeId: 'e', title: 'Nova', status: 'error', objective: 'drifting' })]
    })
  )
  assert.equal(recs.filter((r) => r.nodeId === 'e').length, 1)
  assert.equal(recs[0].kind, 'resolve-error')
})

test('recommend: an idle objective ranks below an active drift', () => {
  const recs = recommend(
    input({
      agents: [
        agent({ nodeId: 'drift', title: 'A', status: 'working', objective: 'drifting' }),
        agent({ nodeId: 'idle', title: 'B', status: 'working', objective: 'idle' })
      ]
    })
  )
  assert.equal(recs[0].nodeId, 'drift')
  assert.equal(recs[1].nodeId, 'idle')
})

// ---- conflicts (already distinct-agent-guaranteed) --------------------------

test('recommend: a board conflict → reconcile-conflict opening the board', () => {
  const recs = recommend(
    input({
      consensus: {
        corroborated: [],
        conflicts: [
          {
            subject: 'auth',
            claims: [
              { agent: 'Nova', value: 'bearer', factId: 'f1' },
              { agent: 'Iris', value: 'apikey', factId: 'f2' }
            ]
          }
        ]
      }
    })
  )
  const c = recs.find((r) => r.kind === 'reconcile-conflict')
  assert.ok(c)
  assert.equal(c!.actionKind, 'open-board')
  assert.equal(c!.nodeId, undefined)
  assert.match(c!.reason, /auth/)
})

// ---- determinism ------------------------------------------------------------

test('recommend: deterministic ordering + cap at 6', () => {
  const agents: AgentSnapshot[] = []
  for (let i = 0; i < 10; i++) {
    agents.push(agent({ nodeId: `n${i}`, title: `N${i}`, status: 'error' }))
  }
  const a = recommend(input({ agents }))
  const b = recommend(input({ agents: [...agents].reverse() }))
  assert.equal(a.length, 6)
  assert.deepEqual(
    a.map((r) => r.id),
    b.map((r) => r.id)
  )
})

test('recommendationColor: every kind has a color', () => {
  for (const k of [
    'resolve-error',
    'confirm-relay',
    'unblock-waiting',
    'review-drift',
    'reconcile-conflict',
    'service-done'
  ] as const) {
    assert.match(recommendationColor(k), /^#[0-9a-f]{6}$/i)
  }
})
