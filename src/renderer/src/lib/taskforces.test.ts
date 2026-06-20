// taskforces.test.ts
//
// PURE unit tests for the Taskforces classifier (lib/taskforces.ts). No DOM, no
// stores, no IPC — every function takes plain data and returns plain data, so
// these run under `node --test` (with a TS loader, or Node's native type
// stripping) or vitest. They lock the core promise: two agents on the same
// subject with NO relay edge => one REDUNDANT taskforce; the same two WITH a relay
// edge => grouped, not redundant; a single agent on a subject => no taskforce;
// ambiguous lines => empty. They mirror consensus.test.ts / criticalPath.test.ts.
//
// We build NodeEvidence/TaskforceEdge-shaped objects with LOCAL helpers so this
// test imports ONLY from ./taskforces (and transitively the pure subjectKey), and
// runs without resolving any zustand store module.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  computeTaskforces,
  MIN_EVIDENCE,
  type NodeEvidence,
  type TaskforceEdge
} from './taskforces'

/** A node working `subject` strongly: N copies of a clearly-on-subject line. */
function authNode(id: string, n = MIN_EVIDENCE): NodeEvidence {
  return { nodeId: id, lines: Array.from({ length: n }, () => 'working on the auth bearer token flow') }
}

function edge(sourceId: string, targetId: string): TaskforceEdge {
  return { sourceId, targetId }
}

test('two agents both on auth, NO relay edge => one redundant taskforce', () => {
  const tf = computeTaskforces([authNode('a'), authNode('b')], [])
  assert.equal(tf.length, 1)
  assert.equal(tf[0].subject, 'auth')
  assert.deepEqual(tf[0].nodeIds, ['a', 'b'])
  assert.equal(tf[0].redundant, true)
})

test('same two agents WITH a relay edge => grouped, NOT redundant', () => {
  const tf = computeTaskforces([authNode('a'), authNode('b')], [edge('a', 'b')])
  assert.equal(tf.length, 1)
  assert.equal(tf[0].subject, 'auth')
  assert.deepEqual(tf[0].nodeIds, ['a', 'b'])
  assert.equal(tf[0].redundant, false)
})

test('relay edge direction does not matter (undirected component)', () => {
  const tf = computeTaskforces([authNode('a'), authNode('b')], [edge('b', 'a')])
  assert.equal(tf.length, 1)
  assert.equal(tf[0].redundant, false)
})

test('three agents, only two relay-linked => still redundant (spans 2 components)', () => {
  const tf = computeTaskforces(
    [authNode('a'), authNode('b'), authNode('c')],
    [edge('a', 'b')] // c is unlinked
  )
  assert.equal(tf.length, 1)
  assert.deepEqual(tf[0].nodeIds, ['a', 'b', 'c'])
  assert.equal(tf[0].redundant, true)
})

test('three agents all in ONE relay component => not redundant', () => {
  const tf = computeTaskforces(
    [authNode('a'), authNode('b'), authNode('c')],
    [edge('a', 'b'), edge('b', 'c')]
  )
  assert.equal(tf.length, 1)
  assert.equal(tf[0].redundant, false)
})

test('single agent on a subject => no taskforce', () => {
  const tf = computeTaskforces([authNode('a')], [])
  assert.deepEqual(tf, [])
})

test('below MIN_EVIDENCE matching lines => the node does not enlist', () => {
  // a has only one on-subject line (< MIN_EVIDENCE); b has enough. No pair forms.
  const a: NodeEvidence = { nodeId: 'a', lines: ['auth bearer token'] }
  const tf = computeTaskforces([a, authNode('b')], [])
  assert.deepEqual(tf, [])
})

test('ambiguous / off-subject lines => empty', () => {
  const a: NodeEvidence = { nodeId: 'a', lines: ['hello there', 'doing some stuff', 'ok'] }
  const b: NodeEvidence = { nodeId: 'b', lines: ['random output', 'more noise'] }
  assert.deepEqual(computeTaskforces([a, b], []), [])
})

test('empty input => empty', () => {
  assert.deepEqual(computeTaskforces([], []), [])
})

test('distinct subjects each form their own taskforce; redundant sorts first', () => {
  // a+b on auth with NO edge (redundant); c+d on db WITH an edge (not redundant).
  const dbNode = (id: string): NodeEvidence => ({
    nodeId: id,
    lines: ['the database is postgres', 'postgres db connection ok']
  })
  const tf = computeTaskforces(
    [authNode('a'), authNode('b'), dbNode('c'), dbNode('d')],
    [edge('c', 'd')]
  )
  assert.equal(tf.length, 2)
  // redundant taskforce (auth) comes first.
  assert.equal(tf[0].subject, 'auth')
  assert.equal(tf[0].redundant, true)
  assert.equal(tf[1].subject, 'db')
  assert.equal(tf[1].redundant, false)
})

test('a node working two subjects can join two taskforces', () => {
  // a works BOTH auth and db; b works auth; c works db. -> auth:{a,b}, db:{a,c}.
  const a: NodeEvidence = {
    nodeId: 'a',
    lines: ['auth bearer token', 'auth flow', 'database postgres', 'postgres db']
  }
  const b = authNode('b')
  const c: NodeEvidence = { nodeId: 'c', lines: ['database postgres', 'postgres db ready'] }
  const tf = computeTaskforces([a, b, c], [])
  const auth = tf.find((t) => t.subject === 'auth')
  const db = tf.find((t) => t.subject === 'db')
  assert.ok(auth)
  assert.deepEqual(auth!.nodeIds, ['a', 'b'])
  assert.ok(db)
  assert.deepEqual(db!.nodeIds, ['a', 'c'])
})

test('deterministic node ordering within a taskforce', () => {
  const tf = computeTaskforces([authNode('z'), authNode('a'), authNode('m')], [])
  assert.equal(tf.length, 1)
  assert.deepEqual(tf[0].nodeIds, ['a', 'm', 'z'])
})

test('pure: does not mutate its inputs', () => {
  const evidence = [authNode('a'), authNode('b')]
  const edges = [edge('a', 'b')]
  const snapEv = JSON.stringify(evidence)
  const snapEd = JSON.stringify(edges)
  computeTaskforces(evidence, edges)
  assert.equal(JSON.stringify(evidence), snapEv)
  assert.equal(JSON.stringify(edges), snapEd)
})
