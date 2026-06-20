// checkpoints.test.ts
//
// PURE unit tests for the Checkpoints helpers' non-IO logic in git.ts:
//   • isValidCheckpointSha — the sha-shape guard that gates the ONE mutating call
//     (restoreCheckpoint -> `git stash apply`) and every diff/exists check.
//   • parseCheckpointStat — turns `git show --stat --format=%at` output into a
//     CheckpointMeta's {ts, files, adds, dels}.
// No DOM, no Electron, no git subprocess — both functions take plain data and
// return plain data, so these run under `node --test` (with a TS loader) or
// vitest, mirroring criticalPath.test.ts / territory.test.ts.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isValidCheckpointSha, parseCheckpointStat } from './git'

test('isValidCheckpointSha accepts plausible lowercase hex shas (7..40)', () => {
  assert.equal(isValidCheckpointSha('abc1234'), true) // 7
  assert.equal(isValidCheckpointSha('0123456789abcdef0123456789abcdef01234567'), true) // 40
  assert.equal(isValidCheckpointSha('deadbeef'), true)
})

test('isValidCheckpointSha rejects bad shapes, traversal, flags, and non-strings', () => {
  assert.equal(isValidCheckpointSha(''), false)
  assert.equal(isValidCheckpointSha('abc12'), false) // too short (5)
  assert.equal(isValidCheckpointSha('0'.repeat(41)), false) // too long (41)
  assert.equal(isValidCheckpointSha('ABCDEF1'), false) // uppercase not allowed
  assert.equal(isValidCheckpointSha('abc123g'), false) // non-hex char
  assert.equal(isValidCheckpointSha('../etc'), false)
  assert.equal(isValidCheckpointSha('--force'), false)
  assert.equal(isValidCheckpointSha('abc 123'), false) // whitespace
  assert.equal(isValidCheckpointSha(null), false)
  assert.equal(isValidCheckpointSha(undefined), false)
  assert.equal(isValidCheckpointSha(42 as unknown), false)
})

test('parseCheckpointStat parses epoch + full diffstat summary', () => {
  const out = [
    '1718000000',
    '',
    ' src/a.ts | 10 ++++++----',
    ' src/b.ts |  3 +++',
    ' 2 files changed, 9 insertions(+), 4 deletions(-)'
  ].join('\n')
  const r = parseCheckpointStat(out)
  assert.ok(r)
  assert.equal(r!.ts, 1718000000 * 1000) // seconds -> ms
  assert.equal(r!.files, 2)
  assert.equal(r!.adds, 9)
  assert.equal(r!.dels, 4)
})

test('parseCheckpointStat handles single file + insertions-only / deletions-only', () => {
  const insOnly = ['1718000001', ' x | 5 +++++', ' 1 file changed, 5 insertions(+)'].join('\n')
  const a = parseCheckpointStat(insOnly)
  assert.ok(a)
  assert.equal(a!.files, 1)
  assert.equal(a!.adds, 5)
  assert.equal(a!.dels, 0)

  const delOnly = ['1718000002', ' y | 2 --', ' 1 file changed, 2 deletions(-)'].join('\n')
  const b = parseCheckpointStat(delOnly)
  assert.ok(b)
  assert.equal(b!.files, 1)
  assert.equal(b!.adds, 0)
  assert.equal(b!.dels, 2)
})

test('parseCheckpointStat returns null when the epoch line is missing/garbage', () => {
  assert.equal(parseCheckpointStat(''), null)
  assert.equal(parseCheckpointStat('not-a-number\n garbage'), null)
})

test('parseCheckpointStat with no diffstat summary yields zeroed counts but valid ts', () => {
  const r = parseCheckpointStat('1718000003\n')
  assert.ok(r)
  assert.equal(r!.ts, 1718000003 * 1000)
  assert.equal(r!.files, 0)
  assert.equal(r!.adds, 0)
  assert.equal(r!.dels, 0)
})
