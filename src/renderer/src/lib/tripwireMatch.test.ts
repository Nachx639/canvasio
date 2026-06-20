// tripwireMatch.test.ts
//
// PURE unit tests for the Tripwire matcher (lib/tripwireMatch.ts). No DOM, no
// stores, no IPC — compile a pattern, test lines. Runs under `node --test`
// (with a TS loader) or vitest. Locks substring matching, regex literals,
// invalid-regex fallback, the empty-pattern no-op, and case-insensitivity.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { compileTripwire, matches } from './tripwireMatch'

test('plain text → case-insensitive substring', () => {
  const c = compileTripwire('tests passed')
  assert.equal(c.kind, 'substring')
  assert.equal(matches(c, 'All tests passed in 3.2s'), true)
  assert.equal(matches(c, 'TESTS PASSED'), true)
  assert.equal(matches(c, 'some tests failed'), false)
})

test('substring matches anywhere in the line', () => {
  const c = compileTripwire('rm -rf')
  assert.equal(matches(c, 'Allow `rm -rf /tmp`? (y/n)'), true)
  assert.equal(matches(c, 'nothing here'), false)
})

test('regex literal compiles and matches', () => {
  const c = compileTripwire('/error TS\\d+/')
  assert.equal(c.kind, 'regex')
  assert.equal(matches(c, 'src/x.ts: error TS2304: cannot find name'), true)
  assert.equal(matches(c, 'error TSxxx: nope'), false)
})

test('regex literal is case-insensitive by default (implicit i flag)', () => {
  const c = compileTripwire('/migration complete/')
  assert.equal(matches(c, 'MIGRATION COMPLETE'), true)
})

test('explicit flags are honored (and i is added)', () => {
  const c = compileTripwire('/^done/m')
  assert.equal(c.kind, 'regex')
  assert.equal(matches(c, 'working\ndone now'), true)
})

test('global regex is deterministic across repeated calls', () => {
  const c = compileTripwire('/http:\\/\\//g')
  assert.equal(matches(c, 'http://localhost:3000'), true)
  // A global regex carries lastIndex; matcher must reset so this stays true.
  assert.equal(matches(c, 'http://localhost:3000'), true)
})

test('invalid regex degrades to a literal substring of the body', () => {
  const c = compileTripwire('/foo[/')
  assert.equal(c.kind, 'substring')
  assert.equal(matches(c, 'a foo[ bar'), true)
  assert.equal(matches(c, 'no match'), false)
})

test('empty / whitespace pattern never fires', () => {
  const empty = compileTripwire('')
  const spaces = compileTripwire('   ')
  assert.equal(matches(empty, 'anything at all'), false)
  assert.equal(matches(spaces, 'anything at all'), false)
})

test('empty line never matches', () => {
  const c = compileTripwire('x')
  assert.equal(matches(c, ''), false)
})

test('a bare slash is treated as plain text, not a regex', () => {
  // "/" alone has no closing body → not a regex literal → plain substring.
  const c = compileTripwire('/')
  assert.equal(c.kind, 'substring')
  assert.equal(matches(c, 'path/to/file'), true)
})
