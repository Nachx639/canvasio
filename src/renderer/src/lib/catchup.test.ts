// catchup.test.ts
//
// PURE unit tests for the Catch-Up delta math (lib/catchup.ts). No DOM, no
// stores, no IPC — feed explicit mission events / echo lines / trail entries /
// changeset + a read-marker, assert the synthesized unread delta. Mirrors the
// node:test convention used by the sibling lib tests. Locks the threshold (which
// milestones count), dedup/coalesce (files counted once, echo capped), cap, and
// newest-first ordering.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildCatchup } from './catchup'
import type { MissionEvent } from '../store/mission'
import type { EchoLine } from '../store/echo'
import type { TrailEntry } from '../store/commandTrail'
import type { NodeChangeset } from '../store/changeset'
import { useI18n } from '../store/i18n'

// catchup.ts now renders labels via i18n t(); pin the locale so these Spanish
// assertions are deterministic regardless of the app default (en).
useI18n.setState({ lang: 'es' })

const ev = (nodeId: string, ts: number, kind: MissionEvent['kind']): MissionEvent => ({
  id: `${nodeId}-${ts}`,
  ts,
  nodeId,
  title: nodeId,
  kind
})
const echo = (ts: number, text = `o${ts}`): EchoLine => ({ text, ts })
const trail = (ts: number, cmd: string, risk: TrailEntry['risk']): TrailEntry => ({
  id: `${ts}`,
  cmd,
  risk,
  ts
})
const changeset = (ts: number, paths: string[]): NodeChangeset => ({
  ts,
  adds: paths.length,
  dels: 0,
  files: paths.map((p) => ({ path: p, status: ' M', adds: 1, dels: 0 }))
})

test('status — only done/error/waiting newer than the marker count', () => {
  const events = [
    ev('a', 10, 'work-start'), // context, not counted
    ev('a', 20, 'done'), // before-equal marker handling below
    ev('a', 40, 'error'),
    ev('a', 50, 'waiting'),
    ev('b', 45, 'done') // different node — ignored
  ]
  const d = buildCatchup('a', 30, { events })
  // ts 40 (error) + ts 50 (waiting) are > 30; the done@20 and work-start@10 are not.
  assert.equal(d.unreadCount, 2)
  assert.equal(d.milestones.length, 2)
  // newest-first
  assert.equal(d.milestones[0].ts, 50)
  assert.equal(d.milestones[1].ts, 40)
  assert.equal(d.milestones[0].kind, 'status')
})

test('status — work-start / spawn / relay never count or appear', () => {
  const events = [ev('a', 40, 'work-start'), ev('a', 50, 'spawn'), ev('a', 60, 'relay')]
  const d = buildCatchup('a', 0, { events })
  assert.equal(d.unreadCount, 0)
  assert.equal(d.milestones.length, 0)
})

test('commands — only destructive/network/vcs count; benign is context only', () => {
  const trailEntries = [
    trail(40, 'ls', 'benign'),
    trail(50, 'npm test', 'buildtest'),
    trail(60, 'rm -rf build', 'destructive'),
    trail(70, 'git push', 'vcs')
  ]
  const d = buildCatchup('a', 30, { events: [], trailEntries })
  // destructive + vcs count (2); ls + npm test surface but don't inflate the pip.
  assert.equal(d.unreadCount, 2)
  assert.equal(d.milestones.length, 4)
  assert.equal(d.milestones[0].label, 'git push')
  assert.equal(d.milestones[0].risk, 'vcs')
})

test('files — a post-marker changeset counts ONCE, files listed as context', () => {
  const cs = changeset(50, ['src/a.ts', 'src/b.ts', 'src/c.ts'])
  const d = buildCatchup('a', 30, { events: [], changeset: cs })
  // one meaningful "3 archivos" milestone, plus 3 non-counted file rows.
  assert.equal(d.unreadCount, 1)
  const meaningful = d.milestones.filter((m) => m.meaningful)
  assert.equal(meaningful.length, 1)
  assert.equal(meaningful[0].label, '3 archivos tocados')
  const fileRows = d.milestones.filter((m) => m.kind === 'files' && m.path)
  assert.equal(fileRows.length, 3)
  assert.equal(fileRows[0].path, 'src/a.ts')
})

test('files — a changeset captured BEFORE the marker is ignored', () => {
  const cs = changeset(20, ['src/a.ts'])
  const d = buildCatchup('a', 30, { events: [], changeset: cs })
  assert.equal(d.unreadCount, 0)
  assert.equal(d.milestones.length, 0)
})

test('output — unread echo lines are capped (coalesced) newest-first', () => {
  const echoLines = [echo(31), echo(32), echo(33), echo(34), echo(35)]
  const d = buildCatchup('a', 30, { events: [], echoLines })
  // 5 unread lines, capped to 3 meaningful output items.
  assert.equal(d.unreadCount, 3)
  const out = d.milestones.filter((m) => m.kind === 'output')
  assert.equal(out.length, 3)
  // newest-first
  assert.equal(out[0].ts, 35)
  assert.equal(out[2].ts, 33)
})

test('output — lines at-or-before the marker do not count', () => {
  const echoLines = [echo(20), echo(30), echo(40)]
  const d = buildCatchup('a', 30, { events: [], echoLines })
  // only ts=40 is strictly newer than 30.
  assert.equal(d.unreadCount, 1)
})

test('never-looked node (marker 0) treats everything as unread', () => {
  const d = buildCatchup('a', 0, {
    events: [ev('a', 10, 'done')],
    echoLines: [echo(20)],
    trailEntries: [trail(30, 'rm -rf x', 'destructive')]
  })
  // done(1) + echo(1) + destructive(1)
  assert.equal(d.unreadCount, 3)
})

test('merged ordering is newest-first across all substrates and newestTs is set', () => {
  const d = buildCatchup('a', 0, {
    events: [ev('a', 10, 'done')],
    echoLines: [echo(40)],
    trailEntries: [trail(30, 'git push', 'vcs')],
    changeset: changeset(20, ['f.ts'])
  })
  assert.equal(d.newestTs, 40)
  assert.equal(d.milestones[0].ts, 40)
  // strictly descending
  for (let i = 1; i < d.milestones.length; i++) {
    assert.ok(d.milestones[i - 1].ts >= d.milestones[i].ts)
  }
})

test('caught-up node returns zero and an empty timeline', () => {
  const d = buildCatchup('a', 100, {
    events: [ev('a', 10, 'done')],
    echoLines: [echo(20)],
    trailEntries: [trail(30, 'rm -rf x', 'destructive')],
    changeset: changeset(40, ['f.ts'])
  })
  assert.equal(d.unreadCount, 0)
  assert.equal(d.milestones.length, 0)
  assert.equal(d.newestTs, 0)
})
