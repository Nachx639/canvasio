// recallMatch.ts
//
// Pure, import-free*, unit-testable relevance + formatting layer for Recall
// (store/recall.ts). Two jobs, both deterministic side-effect-free functions:
//
//   1. matchRecall(facts, task) — score each remembered fact against a freshly
//      spawned agent's TASK text and return the most relevant handful. Scoring is
//      precision-first: a fact whose SUBJECT key (consensus.subjectKey) also
//      appears in the task gets a strong boost; otherwise it competes on raw token
//      overlap. Facts with neither subject match nor any token overlap score 0 and
//      are dropped, so an irrelevant memory never gets injected into an unrelated
//      mission.
//
//   2. recallBlock(matched) — render the chosen facts into ONE compact,
//      terminal-safe line, EXACTLY like boardFormat.formatBoardForInjection: no
//      embedded newline (the delivery path submits with a single trailing '\r'),
//      facts joined by ' · ', the whole block capped to MAX_TOTAL chars. An empty
//      input returns '' so the caller can skip delivery.
//
// * It imports ONLY the pure subjectKey helper from consensus.ts (itself a pure,
//   store-free, IPC-free module) so the EN+ES subject vocabulary stays the single
//   source of truth shared with Consensus and the Insight Harvester. No store, no
//   React, no IPC — trivially unit-testable, mirroring consensus.ts/objective.ts.

import { subjectKey } from './consensus'

/** Shape this needs from a remembered fact; structural so it doesn't import the
 *  store type (mirrors boardFormat.FactLike). */
export interface RecallFactLike {
  text: string
  subject?: string
  value?: string
  agent?: string
  sourceTitle?: string
}

/** Top-N remembered facts surfaced per spawn (precision over recall). */
const MAX_MATCHES = 5
/** Total cap on the produced block so a big memory can't flood a fresh TUI. */
const MAX_TOTAL = 1200
/** Tokens shorter than this, or pure stop-words, don't count toward overlap. */
const MIN_TOKEN = 3

// A tiny EN+ES stop-word set so generic filler ("the", "para", "with") can't
// manufacture a spurious token-overlap match. Precision aid only.
const STOP = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'your', 'you',
  'are', 'was', 'will', 'have', 'has', 'not', 'but', 'all', 'any', 'use', 'using',
  'para', 'con', 'que', 'una', 'uno', 'los', 'las', 'del', 'por', 'como', 'esta',
  'este', 'son', 'fue', 'tiene', 'hacer', 'usar', 'sobre', 'desde'
])

/** Lowercase, split on non-word chars, drop short/stop tokens. Deterministic. */
function tokenize(s: string): Set<string> {
  const out = new Set<string>()
  for (const raw of (s || '').toLowerCase().split(/[^\p{L}\p{N}/.-]+/u)) {
    const t = raw.trim()
    if (t.length < MIN_TOKEN) continue
    if (STOP.has(t)) continue
    out.add(t)
  }
  return out
}

/** A scored fact + its computed relevance, sorted high-to-low by the caller. */
interface Scored {
  fact: RecallFactLike
  score: number
}

/**
 * Score remembered facts against a spawn task and return the top matches.
 * PURE + deterministic.
 *
 * Score per fact = SUBJECT_BONUS (when the fact's subject — explicit on the fact,
 * else derived from its text — is also a subject present in the task text) PLUS
 * the number of distinct task tokens that overlap the fact's text. The fact's own
 * `value` token, when present in the task, adds a small extra nudge. Facts scoring
 * 0 (no subject match, no token overlap) are dropped. Ties break by the order the
 * facts were given (stable), so the most-recently-remembered facts (appended last
 * by the store) win ties — a mild recency preference.
 */
export function matchRecall(
  facts: RecallFactLike[],
  task: string,
  limit = MAX_MATCHES
): RecallFactLike[] {
  if (!facts || facts.length === 0) return []
  const taskText = (task || '').trim()
  if (!taskText) return []

  const SUBJECT_BONUS = 4
  const VALUE_BONUS = 2

  const taskTokens = tokenize(taskText)
  const taskSubject = subjectKey(taskText)

  const scored: Scored[] = []
  facts.forEach((fact, idx) => {
    let score = 0
    // Subject agreement: explicit fact.subject wins; else derive from the text so
    // a remembered fact without a stored subject can still match on its content.
    const factSubject = fact.subject || subjectKey(fact.text)
    if (taskSubject && factSubject && taskSubject === factSubject) score += SUBJECT_BONUS

    // Token overlap between the task and the fact's text.
    const factTokens = tokenize(fact.text)
    for (const t of factTokens) if (taskTokens.has(t)) score += 1

    // The fact's asserted value appearing verbatim in the task is a strong signal.
    const v = (fact.value || '').toLowerCase().trim()
    if (v && v.length >= MIN_TOKEN && taskText.toLowerCase().includes(v)) score += VALUE_BONUS

    if (score > 0) scored.push({ fact, score })
    // idx is captured implicitly by forEach order; stable sort below preserves it.
    void idx
  })

  if (scored.length === 0) return []
  // Stable sort by score desc; Array.prototype.sort is stable in modern engines,
  // so equal scores keep their original (recency) order.
  scored.sort((a, b) => b.score - a.score)
  const n = Math.max(1, Math.min(limit, MAX_MATCHES))
  return scored.slice(0, n).map((s) => s.fact)
}

/**
 * Build a one-line, terminal-safe "Lo que ya sabemos" block from matched facts,
 * mirroring boardFormat.formatBoardForInjection EXACTLY (single line, ' · ' join,
 * MAX_TOTAL cap). Each fact renders as "[Attribution] text" (attribution = source
 * title or agent, omitted when neither is known). Returns '' for an empty input so
 * the caller can skip delivery. PURE + deterministic.
 */
export function recallBlock(facts: RecallFactLike[]): string {
  if (!facts || facts.length === 0) return ''
  const parts: string[] = []
  for (const f of facts) {
    const text = (f.text || '').replace(/\s+/g, ' ').trim()
    if (!text) continue
    const who = (f.sourceTitle || f.agent || '').replace(/\s+/g, ' ').trim()
    parts.push(who ? `[${who}] ${text}` : text)
  }
  if (parts.length === 0) return ''
  let block = 'Lo que ya sabemos: ' + parts.join(' · ')
  if (block.length > MAX_TOTAL) block = block.slice(0, MAX_TOTAL - 1) + '…'
  return block
}
