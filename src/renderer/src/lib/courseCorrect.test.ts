// courseCorrect.test.ts
//
// PURE unit tests for the Course Correct reasoner (lib/courseCorrect.ts). No DOM,
// no stores, no IPC — every input is plain data and every output is plain data, so
// these run under `node --test` (with a TS loader / native type stripping) or
// vitest, exactly like consensus.test.ts. They lock the happy path (one still-
// running minority claimant vs. a single clear team value), and every precision
// guard: ambiguous team value, no live claimant, multiple live claimants, a claim
// whose source node is done/error (can't act), de-dup, and the MAX cap.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  computeCourseCorrections,
  MAX_CORRECTIONS,
  type CourseCorrectInput,
  type LiveNode
} from './courseCorrect'
import type { Conflict } from './consensus'

function conflict(subject: string, claims: Conflict['claims']): Conflict {
  return { subject, claims }
}

// ---- happy path ------------------------------------------------------------

test('emits a correction for a single still-running minority claimant', () => {
  const input: CourseCorrectInput = {
    conflicts: [
      conflict('auth', [
        { agent: 'Atlas', value: 'apikey', factId: 'f1' },
        { agent: 'Nova', value: 'bearer', factId: 'f2' }
      ])
    ],
    // Atlas's claim came from node n1 (still working); Nova's from n2 (done).
    facts: [
      { id: 'f1', sourceNodeId: 'n1' },
      { id: 'f2', sourceNodeId: 'n2' }
    ],
    liveNodes: [
      { id: 'n1', title: 'Atlas', status: 'working' },
      { id: 'n2', title: 'Nova', status: 'done' }
    ]
  }
  const out = computeCourseCorrections(input)
  assert.equal(out.length, 1)
  const c = out[0]
  assert.equal(c.targetNodeId, 'n1')
  assert.equal(c.targetTitle, 'Atlas')
  assert.equal(c.subject, 'auth')
  assert.equal(c.staleValue, 'apikey')
  assert.equal(c.teamValue, 'bearer')
  assert.ok(c.note.includes('auth'))
  assert.ok(c.note.includes('bearer'))
  assert.ok(c.note.includes('apikey'))
  assert.ok(!c.note.includes('\n'))
  assert.equal(c.id, 'n1:auth:apikey->bearer')
})

test('an idle minority node can still be corrected', () => {
  const input: CourseCorrectInput = {
    conflicts: [
      conflict('db', [
        { agent: 'A', value: 'mysql', factId: 'f1' },
        { agent: 'B', value: 'postgres', factId: 'f2' }
      ])
    ],
    facts: [
      { id: 'f1', sourceNodeId: 'n1' },
      { id: 'f2', sourceNodeId: 'n2' }
    ],
    liveNodes: [
      { id: 'n1', title: 'A', status: 'idle' },
      { id: 'n2', title: 'B', status: 'idle' }
    ]
  }
  // Both live -> two live claimants -> ambiguous which one drifted -> OMIT.
  assert.equal(computeCourseCorrections(input).length, 0)
})

// ---- precision guards ------------------------------------------------------

test('no live claimant -> no correction (both nodes finished)', () => {
  const input: CourseCorrectInput = {
    conflicts: [
      conflict('auth', [
        { agent: 'A', value: 'apikey', factId: 'f1' },
        { agent: 'B', value: 'bearer', factId: 'f2' }
      ])
    ],
    facts: [
      { id: 'f1', sourceNodeId: 'n1' },
      { id: 'f2', sourceNodeId: 'n2' }
    ],
    liveNodes: [
      { id: 'n1', title: 'A', status: 'done' },
      { id: 'n2', title: 'B', status: 'error' }
    ]
  }
  assert.equal(computeCourseCorrections(input).length, 0)
})

test('exactly one live minority among three claims, single team value -> correction', () => {
  const input: CourseCorrectInput = {
    conflicts: [
      conflict('auth', [
        { agent: 'A', value: 'bearer', factId: 'f1' },
        { agent: 'B', value: 'bearer', factId: 'f2' },
        { agent: 'C', value: 'apikey', factId: 'f3' }
      ])
    ],
    facts: [
      { id: 'f1', sourceNodeId: 'n1' },
      { id: 'f2', sourceNodeId: 'n2' },
      { id: 'f3', sourceNodeId: 'n3' }
    ],
    liveNodes: [
      { id: 'n1', title: 'A', status: 'done' },
      { id: 'n2', title: 'B', status: 'done' },
      { id: 'n3', title: 'C', status: 'working' } // the lone live minority
    ]
  }
  const out = computeCourseCorrections(input)
  assert.equal(out.length, 1)
  assert.equal(out[0].targetNodeId, 'n3')
  assert.equal(out[0].staleValue, 'apikey')
  assert.equal(out[0].teamValue, 'bearer')
})

test('ambiguous team value (others disagree among themselves) -> OMIT', () => {
  const input: CourseCorrectInput = {
    conflicts: [
      conflict('auth', [
        { agent: 'A', value: 'apikey', factId: 'f1' }, // lone live minority
        { agent: 'B', value: 'bearer', factId: 'f2' },
        { agent: 'C', value: 'oauth', factId: 'f3' }
      ])
    ],
    facts: [
      { id: 'f1', sourceNodeId: 'n1' },
      { id: 'f2', sourceNodeId: 'n2' },
      { id: 'f3', sourceNodeId: 'n3' }
    ],
    liveNodes: [
      { id: 'n1', title: 'A', status: 'working' },
      { id: 'n2', title: 'B', status: 'done' },
      { id: 'n3', title: 'C', status: 'done' }
    ]
  }
  // The "team" doesn't agree (bearer vs oauth) -> no single team value -> OMIT.
  assert.equal(computeCourseCorrections(input).length, 0)
})

test('a claim with no resolvable source node is ignored', () => {
  const input: CourseCorrectInput = {
    conflicts: [
      conflict('auth', [
        { agent: 'A', value: 'apikey', factId: 'f1' },
        { agent: 'B', value: 'bearer', factId: 'fX' } // factId not in facts
      ])
    ],
    facts: [{ id: 'f1', sourceNodeId: 'n1' }],
    liveNodes: [{ id: 'n1', title: 'A', status: 'working' }]
  }
  // Only one resolvable live claimant (A), but the OTHER claim still defines the
  // team value 'bearer' (it remains in the conflict's claims list).
  const out = computeCourseCorrections(input)
  assert.equal(out.length, 1)
  assert.equal(out[0].targetNodeId, 'n1')
  assert.equal(out[0].teamValue, 'bearer')
})

test('empty conflicts -> empty result', () => {
  assert.deepEqual(
    computeCourseCorrections({ conflicts: [], facts: [], liveNodes: [] }),
    []
  )
})

// ---- de-dup + cap ----------------------------------------------------------

test('duplicate corrections are de-duplicated by id', () => {
  const c = conflict('auth', [
    { agent: 'A', value: 'apikey', factId: 'f1' },
    { agent: 'B', value: 'bearer', factId: 'f2' }
  ])
  const input: CourseCorrectInput = {
    conflicts: [c, c], // same conflict twice
    facts: [
      { id: 'f1', sourceNodeId: 'n1' },
      { id: 'f2', sourceNodeId: 'n2' }
    ],
    liveNodes: [
      { id: 'n1', title: 'A', status: 'working' },
      { id: 'n2', title: 'B', status: 'done' }
    ]
  }
  assert.equal(computeCourseCorrections(input).length, 1)
})

test('caps the number of corrections to MAX_CORRECTIONS', () => {
  const subjects = ['auth', 'db', 'port', 'endpoint', 'api base', 'verdict']
  const conflicts: Conflict[] = []
  const facts: { id: string; sourceNodeId?: string }[] = []
  const liveNodes: LiveNode[] = []
  subjects.forEach((subject, i) => {
    const fMin = `min${i}`
    const fTeam = `team${i}`
    const nMin = `nmin${i}`
    const nTeam = `nteam${i}`
    conflicts.push(
      conflict(subject, [
        { agent: `Min${i}`, value: 'stale', factId: fMin },
        { agent: `Team${i}`, value: 'good', factId: fTeam }
      ])
    )
    facts.push({ id: fMin, sourceNodeId: nMin }, { id: fTeam, sourceNodeId: nTeam })
    liveNodes.push(
      { id: nMin, title: `Min${i}`, status: 'working' },
      { id: nTeam, title: `Team${i}`, status: 'done' }
    )
  })
  const out = computeCourseCorrections({ conflicts, facts, liveNodes })
  assert.equal(out.length, MAX_CORRECTIONS)
})
