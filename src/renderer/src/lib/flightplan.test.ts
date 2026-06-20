// flightplan.test.ts
//
// PURE unit tests for the Flightplan pre-flight conflict classifier
// (lib/flightplan.ts). No DOM, no stores, no IPC — every function takes plain
// data and returns plain data, so these run under `node --test` (with a TS loader,
// or Node's native type stripping) or vitest. They lock the path-overlap detection
// (same file → conflict), dir-overlap, glob, subject-overlap via subjectKey, the
// precision guards (no path + no subject → no conflict), self-exclusion, ranking
// (path beats subject), one-hit-per-incumbent dedup, and the cap.
//
// We build Incumbent-shaped plain objects with LOCAL helpers so this test imports
// ONLY from ./flightplan, keeping it self-contained and runnable without resolving
// any zustand store module.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  extractTargets,
  predictConflicts,
  basename,
  type Incumbent
} from './flightplan'

/** Minimal structural Incumbent for the tests. */
function inc(over: Partial<Incumbent> & { nodeId: string }): Incumbent {
  return { title: over.nodeId, dirtyPaths: [], subjects: [], ...over }
}

// ---- basename --------------------------------------------------------------

test('basename: last segment, trailing-slash tolerant', () => {
  assert.equal(basename('src/auth/session.ts'), 'session.ts')
  assert.equal(basename('src/auth/'), 'auth')
  assert.equal(basename('session.ts'), 'session.ts')
})

// ---- extractTargets --------------------------------------------------------

test('extractTargets: pulls explicit file paths', () => {
  const { paths } = extractTargets('fix the auth middleware in src/auth/session.ts')
  assert.ok(paths.includes('src/auth/session.ts'))
})

test('extractTargets: pulls dir and glob tokens', () => {
  const dir = extractTargets('refactor everything under src/api/')
  assert.ok(dir.paths.includes('src/api/'))
  const glob = extractTargets('lint all *.ts files')
  assert.ok(glob.paths.some((p) => p === '*.ts'))
})

test('extractTargets: folds the task + path segments into subjects', () => {
  // Prose subject via subjectKey.
  assert.ok(extractTargets('rework the authentication flow').subjects.includes('auth'))
  // Subject implied by a path segment even when prose is terse.
  assert.ok(extractTargets('edit src/auth/session.ts').subjects.includes('auth'))
})

test('extractTargets: ambiguous prose implies nothing (precision guard)', () => {
  const t = extractTargets('please make this look nicer and faster')
  assert.deepEqual(t.paths, [])
  assert.deepEqual(t.subjects, [])
})

test('extractTargets: dedups repeated paths', () => {
  const { paths } = extractTargets('touch src/a.ts then test src/a.ts again')
  assert.equal(paths.filter((p) => p === 'src/a.ts').length, 1)
})

// ---- predictConflicts: path overlap ----------------------------------------

test('predictConflicts: same file basename → path conflict', () => {
  const targets = extractTargets('fix src/auth/session.ts')
  const out = predictConflicts(targets, [
    inc({ nodeId: 'A', title: 'Atlas', dirtyPaths: ['src/auth/session.ts'] })
  ])
  assert.equal(out.length, 1)
  assert.equal(out[0].kind, 'path')
  assert.equal(out[0].nodeId, 'A')
})

test('predictConflicts: same directory → path conflict', () => {
  const targets = extractTargets('add a logout route in src/auth/logout.ts')
  const out = predictConflicts(targets, [
    inc({ nodeId: 'A', title: 'Atlas', dirtyPaths: ['src/auth/session.ts'] })
  ])
  assert.equal(out.length, 1)
  assert.equal(out[0].kind, 'path')
})

test('predictConflicts: glob target matches dirty extension', () => {
  const out = predictConflicts(extractTargets('format all *.ts'), [
    inc({ nodeId: 'A', dirtyPaths: ['src/auth/session.ts'] })
  ])
  assert.equal(out.length, 1)
  assert.equal(out[0].kind, 'path')
})

// ---- predictConflicts: subject overlap -------------------------------------

test('predictConflicts: shared subject → subject conflict (weaker)', () => {
  // No path overlap (different areas), but both touch the "auth" subject.
  const out = predictConflicts(extractTargets('rework the auth token logic'), [
    inc({ nodeId: 'A', title: 'Atlas', dirtyPaths: ['lib/widgets/x.ts'], subjects: ['auth'] })
  ])
  assert.equal(out.length, 1)
  assert.equal(out[0].kind, 'subject')
  assert.equal(out[0].detail, 'auth')
})

// ---- precision / safety guards ---------------------------------------------

test('predictConflicts: no path + no subject → no conflict', () => {
  const out = predictConflicts(extractTargets('make it pretty'), [
    inc({ nodeId: 'A', dirtyPaths: ['src/auth/session.ts'], subjects: ['auth'] })
  ])
  assert.deepEqual(out, [])
})

test('predictConflicts: never flags the spawning node against itself', () => {
  const targets = extractTargets('fix src/auth/session.ts')
  const out = predictConflicts(
    targets,
    [inc({ nodeId: 'SELF', dirtyPaths: ['src/auth/session.ts'] })],
    'SELF'
  )
  assert.deepEqual(out, [])
})

test('predictConflicts: empty incumbents → nothing', () => {
  assert.deepEqual(predictConflicts(extractTargets('fix src/a.ts'), []), [])
})

// ---- ranking + dedup + cap -------------------------------------------------

test('predictConflicts: path overlap ranks above subject overlap', () => {
  const targets = extractTargets('fix src/auth/session.ts')
  const out = predictConflicts(targets, [
    // subject-only incumbent
    inc({ nodeId: 'S', title: 'SubjAgent', dirtyPaths: ['other/x.ts'], subjects: ['auth'] }),
    // path-overlap incumbent
    inc({ nodeId: 'P', title: 'PathAgent', dirtyPaths: ['src/auth/session.ts'] })
  ])
  assert.equal(out.length, 2)
  assert.equal(out[0].kind, 'path')
  assert.equal(out[0].nodeId, 'P')
  assert.equal(out[1].kind, 'subject')
})

test('predictConflicts: one hit per incumbent (keeps strongest)', () => {
  // Incumbent overlaps on BOTH path and subject; only the path hit is emitted.
  const targets = extractTargets('fix the auth in src/auth/session.ts')
  const out = predictConflicts(targets, [
    inc({ nodeId: 'A', dirtyPaths: ['src/auth/session.ts'], subjects: ['auth'] })
  ])
  assert.equal(out.length, 1)
  assert.equal(out[0].kind, 'path')
})

test('predictConflicts: caps output at 6', () => {
  const targets = extractTargets('fix src/auth/session.ts')
  const many: Incumbent[] = []
  for (let i = 0; i < 12; i++) {
    many.push(inc({ nodeId: `N${i}`, title: `T${i}`, dirtyPaths: ['src/auth/session.ts'] }))
  }
  const out = predictConflicts(targets, many)
  assert.equal(out.length, 6)
})
