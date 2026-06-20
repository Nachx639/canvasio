// criticalPath.test.ts
//
// PURE unit tests for the Critical Path intelligence (lib/criticalPath.ts). No
// DOM, no stores, no IPC — every function takes plain data and returns plain data,
// so these run under `node --test` (with a TS loader) or vitest. They lock the
// blocked-agent detection, the bottleneck selection, the critical-chain walk, and
// the cycle-safety + empty/ambiguous (renders nothing) cases.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildDeps,
  blockedAgents,
  bottleneck,
  criticalChain,
  computeCriticalPath,
  type CritEdge,
  type NodeStatus
} from './criticalPath'

/** Build an armed edge (the common case). */
function edge(sourceId: string, targetId: string, armed = true): CritEdge {
  return { sourceId, targetId, armed }
}

/** Convenience: a status map + the known-node set from its keys. */
function world(s: Record<string, NodeStatus>): {
  status: Map<string, NodeStatus>
  known: Set<string>
} {
  const status = new Map(Object.entries(s)) as Map<string, NodeStatus>
  return { status, known: new Set(status.keys()) }
}

test('buildDeps: armed-only, drops self + unknown edges', () => {
  const known = new Set(['a', 'b', 'c'])
  const adj = buildDeps(
    [edge('a', 'b'), edge('b', 'c', false), edge('a', 'a'), edge('a', 'z')],
    known
  )
  assert.deepEqual(adj.get('a'), ['b'])
  // b->c is unarmed, a->a is self, a->z references an unknown node: all dropped.
  assert.equal(adj.has('b'), false)
})

test('linear chain A->B->C, A working => B,C blocked, bottleneck A', () => {
  const edges = [edge('a', 'b'), edge('b', 'c')]
  const { status, known } = world({ a: 'working', b: 'idle', c: 'idle' })

  const blocked = blockedAgents(edges, status, known)
  // B is directly waiting on busy A; C is directly waiting on idle B (not busy),
  // so C is NOT a *directly* blocked agent — but it IS transitive downstream.
  assert.deepEqual(blocked.map((b) => b.nodeId), ['b'])
  assert.deepEqual(blocked[0].waitingOn, ['a'])

  const bn = bottleneck(edges, status, known)
  assert.equal(bn.id, 'a')
  // A transitively holds up B (blocked). C is not counted as blocked (its direct
  // upstream B is idle, not busy), so held === 1.
  assert.equal(bn.held, 1)

  const chain = criticalChain(bn.id, edges, known)
  assert.deepEqual(chain, ['a', 'b', 'c'])
})

test('diamond fan-out: one busy root holds up multiple blocked leaves', () => {
  // a -> b, a -> c, b -> d, c -> d
  const edges = [edge('a', 'b'), edge('a', 'c'), edge('b', 'd'), edge('c', 'd')]
  const { status, known } = world({ a: 'working', b: 'idle', c: 'idle', d: 'idle' })

  const blocked = blockedAgents(edges, status, known)
  // b and c wait directly on busy a; d waits on idle b/c (not busy) -> not direct.
  assert.deepEqual(blocked.map((x) => x.nodeId), ['b', 'c'])

  const bn = bottleneck(edges, status, known)
  assert.equal(bn.id, 'a')
  assert.equal(bn.held, 2) // a transitively holds up b and c (both blocked)

  // The chain walks the longest downstream path from a (length 3: a,b/c,d).
  const chain = criticalChain(bn.id, edges, known)
  assert.equal(chain[0], 'a')
  assert.equal(chain[chain.length - 1], 'd')
  assert.equal(chain.length, 3)
})

test('competing busy sources: the one holding up MORE blocked work wins', () => {
  // x -> p (one downstream); y -> q, y -> r (two downstream).
  const edges = [edge('x', 'p'), edge('y', 'q'), edge('y', 'r')]
  const { status, known } = world({
    x: 'working',
    y: 'working',
    p: 'idle',
    q: 'idle',
    r: 'idle'
  })
  const bn = bottleneck(edges, status, known)
  assert.equal(bn.id, 'y')
  assert.equal(bn.held, 2)
})

test('errored upstream is also a blocker', () => {
  const edges = [edge('a', 'b')]
  const { status, known } = world({ a: 'error', b: 'idle' })
  const blocked = blockedAgents(edges, status, known)
  assert.deepEqual(blocked.map((x) => x.nodeId), ['b'])
  assert.equal(bottleneck(edges, status, known).id, 'a')
})

test('no blocked agents when upstream is done -> empty readout (renders nothing)', () => {
  const edges = [edge('a', 'b'), edge('b', 'c')]
  const { status, known } = world({ a: 'done', b: 'idle', c: 'idle' })
  const cp = computeCriticalPath(edges, status, known)
  assert.deepEqual(cp.blocked, [])
  assert.equal(cp.bottleneckId, null)
  assert.equal(cp.bottleneckHeld, 0)
  assert.deepEqual(cp.chain, [])
})

test('a target already working is not blocked', () => {
  const edges = [edge('a', 'b')]
  const { status, known } = world({ a: 'working', b: 'working' })
  assert.deepEqual(blockedAgents(edges, status, known), [])
  assert.equal(bottleneck(edges, status, known).id, null)
})

test('unarmed (already fired) rules encode no pending dependency', () => {
  const edges = [edge('a', 'b', false)]
  const { status, known } = world({ a: 'working', b: 'idle' })
  const cp = computeCriticalPath(edges, status, known)
  assert.deepEqual(cp.blocked, [])
  assert.equal(cp.bottleneckId, null)
})

test('cycle safety: a relay loop never hangs and still resolves', () => {
  // a -> b -> c -> a, all referenced; a busy.
  const edges = [edge('a', 'b'), edge('b', 'c'), edge('c', 'a')]
  const { status, known } = world({ a: 'working', b: 'idle', c: 'idle' })
  // Must terminate. b is blocked on busy a.
  const cp = computeCriticalPath(edges, status, known)
  assert.ok(cp.blocked.some((x) => x.nodeId === 'b'))
  // Chain starts at the bottleneck and is bounded (no infinite loop, no dup ids).
  assert.equal(cp.chain[0], cp.bottleneckId)
  assert.equal(new Set(cp.chain).size, cp.chain.length)
})

test('undefined status (fresh node) counts as waiting', () => {
  const edges = [edge('a', 'b')]
  const status = new Map<string, NodeStatus>([['a', 'working']]) // b has no status
  const known = new Set(['a', 'b'])
  const blocked = blockedAgents(edges, status, known)
  assert.deepEqual(blocked.map((x) => x.nodeId), ['b'])
})

test('empty inputs yield an empty, stable readout', () => {
  const cp = computeCriticalPath([], new Map(), new Set())
  assert.deepEqual(cp.blocked, [])
  assert.equal(cp.bottleneckId, null)
  assert.deepEqual(cp.chain, [])
})
