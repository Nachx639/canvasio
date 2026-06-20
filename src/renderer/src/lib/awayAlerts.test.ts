// awayAlerts.test.ts
//
// PURE unit tests for the Away Alerts copy-builder (lib/awayAlerts.ts). No DOM,
// no stores, no IPC — shouldNotify() / alertKindOf() take plain fixtures and
// return deterministic results, so these run under `node --test` (with a TS
// loader) or vitest, matching the conductor.test.ts / tripwireMatch.test.ts
// convention.
//
// They lock the load-bearing guarantees:
//   - each human-relevant kind (done/error/waiting) yields a payload with the name,
//   - non-human-relevant kinds (spawn/work-start/relay/close) yield null,
//   - a disabled type yields null even for its own kind,
//   - a missing/blank title degrades to a sane default name,
//   - alertKindOf maps only the three relevant kinds.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { shouldNotify, alertKindOf, type AwayOpts } from './awayAlerts'
import { useI18n } from '../store/i18n'

// awayAlerts.ts now builds copy via i18n t(); pin the locale so these Spanish
// assertions are deterministic regardless of the app default (en).
useI18n.setState({ lang: 'es' })

const ALL: AwayOpts = { notifyDone: true, notifyWaiting: true, notifyError: true }

test('waiting → "needs your input" payload with the agent name', () => {
  const n = shouldNotify({ kind: 'waiting', title: 'Nova' }, ALL)
  assert.ok(n)
  assert.match(n!.title, /Nova/)
  assert.match(n!.title, /necesita tu respuesta/)
  assert.ok(n!.body.length > 0)
})

test('error → error payload with the agent name', () => {
  const n = shouldNotify({ kind: 'error', title: 'Dax' }, ALL)
  assert.ok(n)
  assert.match(n!.title, /Dax/)
  assert.match(n!.title, /error/i)
})

test('done → finished payload with the agent name', () => {
  const n = shouldNotify({ kind: 'done', title: 'Nova' }, ALL)
  assert.ok(n)
  assert.match(n!.title, /Nova/)
  assert.match(n!.title, /terminó/)
})

test('non-human-relevant kinds → null', () => {
  for (const kind of ['spawn', 'work-start', 'relay', 'close'] as const) {
    assert.equal(shouldNotify({ kind, title: 'X' }, ALL), null)
  }
})

test('disabled type → null even for its own kind', () => {
  assert.equal(shouldNotify({ kind: 'done', title: 'X' }, { ...ALL, notifyDone: false }), null)
  assert.equal(shouldNotify({ kind: 'error', title: 'X' }, { ...ALL, notifyError: false }), null)
  assert.equal(shouldNotify({ kind: 'waiting', title: 'X' }, { ...ALL, notifyWaiting: false }), null)
})

test('only the matching type being off suppresses; others still fire', () => {
  const opts: AwayOpts = { notifyDone: false, notifyWaiting: true, notifyError: true }
  assert.equal(shouldNotify({ kind: 'done', title: 'X' }, opts), null)
  assert.ok(shouldNotify({ kind: 'waiting', title: 'X' }, opts))
  assert.ok(shouldNotify({ kind: 'error', title: 'X' }, opts))
})

test('missing / blank title → sane default name', () => {
  const a = shouldNotify({ kind: 'done' }, ALL)
  const b = shouldNotify({ kind: 'done', title: '   ' }, ALL)
  assert.ok(a && /Un agente/.test(a.title))
  assert.ok(b && /Un agente/.test(b.title))
})

test('alertKindOf maps only the three relevant kinds', () => {
  assert.equal(alertKindOf('done'), 'done')
  assert.equal(alertKindOf('error'), 'error')
  assert.equal(alertKindOf('waiting'), 'waiting')
  for (const k of ['spawn', 'work-start', 'relay', 'close'] as const) {
    assert.equal(alertKindOf(k), null)
  }
})
