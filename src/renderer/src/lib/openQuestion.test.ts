// openQuestion.test.ts
//
// PURE unit tests for the Open Questions detector + matcher (lib/openQuestion.ts).
// No DOM, no stores, no IPC — every function takes plain data and returns plain
// data, so these run under `node --test` (with a TS loader / native type
// stripping) or vitest, exactly like insightHarvest.test / consensus.test.
//
// They lock: positive question detection (EN + ES), rejection of statements /
// bare commands / echoed interactive prompts / too-short lines, subject tagging
// (shared with consensus.subjectKey), answer-source scoring by shared subject,
// the self-answer guard, and the no-match -> [] precision contract.
//
// BoardFact-shaped objects are built with a LOCAL helper so this test imports
// ONLY from ./openQuestion (the BoardFact type is structural here).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  isQuestion,
  detectQuestion,
  scoreAnswerSources,
  type NodeExcerpt
} from './openQuestion'

/** Minimal structural BoardFact for the tests (matches store/board.ts shape). */
function fact(over: {
  id: string
  text: string
  agent?: string
  sourceTitle?: string
  ts?: number
}): { id: string; ts: number; text: string; agent?: string; sourceTitle?: string } {
  const { ts, ...rest } = over
  return { ts: ts ?? Date.now(), ...rest }
}

function excerpt(over: Partial<NodeExcerpt> & { nodeId: string; excerpt: string }): NodeExcerpt {
  return { title: over.title ?? 'Agente', ts: over.ts ?? Date.now(), ...over }
}

// ---- isQuestion / detectQuestion: positives --------------------------------

test('detectQuestion: English questions are detected', () => {
  assert.ok(isQuestion('Should I use Redis here?'))
  assert.ok(isQuestion('Which auth scheme are we using?'))
  assert.ok(detectQuestion('Should I use Redis here?'))
})

test('detectQuestion: Spanish questions (¿…?) are detected', () => {
  assert.ok(isQuestion('¿Cuál es el endpoint de login?'))
  assert.ok(isQuestion('¿Qué base de datos usamos?'))
  const q = detectQuestion('¿Cuál es el endpoint de login?')
  assert.ok(q)
  assert.equal(q!.subject, 'endpoint')
})

test('detectQuestion: tags subject via shared consensus vocabulary', () => {
  assert.equal(detectQuestion('Should I use Redis here?')!.subject, 'db')
  assert.equal(detectQuestion('What auth scheme should we use?')!.subject, 'auth')
  assert.equal(detectQuestion('Which port does the server listen on?')!.subject, 'port')
})

test('detectQuestion: caps long text', () => {
  const long = 'Should we use ' + 'x'.repeat(300) + '?'
  const q = detectQuestion(long)
  assert.ok(q)
  assert.ok(q!.text.length <= 160)
})

// ---- rejections (precision guards) -----------------------------------------

test('detectQuestion: rejects plain statements', () => {
  assert.equal(detectQuestion('auth is a bearer token'), null)
  assert.equal(detectQuestion('all 12 tests pass'), null)
})

test('detectQuestion: rejects bare shell commands', () => {
  assert.equal(detectQuestion('$ test -f build/out?'), null)
})

test('detectQuestion: rejects echoed interactive y/n prompts', () => {
  assert.equal(detectQuestion('Allow `rm -rf build`? (y/n)'), null)
  assert.equal(detectQuestion('Continue? [Y/n]'), null)
})

test('detectQuestion: rejects TUI footer chrome', () => {
  assert.equal(detectQuestion('press ? for shortcuts'), null)
})

test('detectQuestion: rejects too-short fragments', () => {
  assert.equal(detectQuestion('ok?'), null)
})

test('detectQuestion: rejects a trailing-? line with no asking cue', () => {
  // No ¿ opener and no interrogative/first-person cue -> not treated as a query.
  assert.equal(detectQuestion('the build output??'), null)
})

// ---- scoreAnswerSources: fact match ----------------------------------------

test('scoreAnswerSources: a board fact on the same subject answers', () => {
  const q = detectQuestion('Which database should I use?')!
  assert.equal(q.subject, 'db')
  const facts = [
    fact({ id: 'f1', text: 'we are using Postgres for the queue', agent: 'Atlas' })
  ]
  const ranked = scoreAnswerSources(q, facts, [])
  assert.equal(ranked.length, 1)
  assert.equal(ranked[0].kind, 'fact')
  assert.equal(ranked[0].source, 'Atlas')
  assert.equal(ranked[0].refId, 'f1')
})

test('scoreAnswerSources: a sibling agent excerpt on the same subject answers', () => {
  const q = detectQuestion('What is the API base?')!
  assert.equal(q.subject, 'api base')
  const nodes = [excerpt({ nodeId: 'n2', title: 'Nova', excerpt: 'the API base is /v2' })]
  const ranked = scoreAnswerSources(q, [], nodes, 'n1')
  assert.equal(ranked.length, 1)
  assert.equal(ranked[0].kind, 'agent')
  assert.equal(ranked[0].source, 'Nova')
  assert.equal(ranked[0].refId, 'n2')
})

test('scoreAnswerSources: a pinned fact outranks a sibling excerpt', () => {
  const q = detectQuestion('Which database should I use?')!
  const facts = [fact({ id: 'f1', text: 'using Postgres', agent: 'Atlas' })]
  const nodes = [excerpt({ nodeId: 'n2', title: 'Nova', excerpt: 'we should use redis' })]
  const ranked = scoreAnswerSources(q, facts, nodes, 'n1')
  assert.ok(ranked.length >= 2)
  assert.equal(ranked[0].kind, 'fact')
})

test('scoreAnswerSources: never answers from the asking node itself', () => {
  const q = detectQuestion('What database should I use?')!
  const nodes = [excerpt({ nodeId: 'n1', title: 'Self', excerpt: 'using postgres' })]
  const ranked = scoreAnswerSources(q, [], nodes, 'n1')
  assert.deepEqual(ranked, [])
})

// ---- scoreAnswerSources: precision (no match) ------------------------------

test('scoreAnswerSources: no subject -> empty', () => {
  const q = { text: 'is this looking good so far?', subject: null }
  assert.deepEqual(scoreAnswerSources(q, [], []), [])
})

test('scoreAnswerSources: different subjects do not match', () => {
  const q = detectQuestion('Which database should I use?')! // db
  const facts = [fact({ id: 'f1', text: 'auth is a bearer token', agent: 'Atlas' })]
  assert.deepEqual(scoreAnswerSources(q, facts, []), [])
})

test('scoreAnswerSources: empty inputs -> empty', () => {
  const q = detectQuestion('Which database should I use?')!
  assert.deepEqual(scoreAnswerSources(q, [], []), [])
})
