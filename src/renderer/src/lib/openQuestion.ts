// openQuestion.ts
//
// Open Questions — the PURE detector + answer-matcher behind the swarm's
// "unblock bus". It is the deliberate INVERSE of insightHarvest.ts: where the
// Insight Harvester catches discovery-grade FACTS and explicitly THROWS QUESTIONS
// AWAY (its QUESTION_RE guard returns null on any line ending in '?' / starting
// '¿'), this module catches exactly those rejected lines — the moments an agent
// signals it DOESN'T know something — and turns each into an Open Question.
//
// Two pure functions, no side effects:
//   * detectQuestion(line)            -> { text, subject } | null
//   * scoreAnswerSources(q, facts, …) -> ranked answer candidates ([] when none)
//
// PURITY CONTRACT (mirrors insightHarvest.ts / consensus.ts / objective.ts):
//   - imports ONLY types + the consensus subject normalizer; no zustand store,
//     no React, no IPC, never mutates inputs, fully deterministic, unit-testable.
//   - The caller (TerminalOverlay) owns the chokepoint, the throttle, the store
//     write. This file only CLASSIFIES + MATCHES. It never has side effects.
//   - Precision over recall: we would rather miss a real question than flood the
//     panel with rhetorical chatter or echoed prompts. When unsure, return null /
//     []. The two surfaces (this + Consensus) share subjectKey() VERBATIM so a
//     question and a fact agree on what a "subject" is — that shared vocabulary is
//     the entire mechanism by which a question finds its answer.
//
// What counts as a genuine agent question (Spanish + English):
//   detectQuestion("Should I use Redis here?")       -> { text, subject: 'db' }
//   detectQuestion("¿Cuál es el endpoint de login?") -> { text, subject: 'endpoint' }
//   detectQuestion("What auth scheme are we using?")  -> { text, subject: 'auth' }
//
// What we REJECT (precision guards), returning null:
//   * Statements / verdicts        no '?' and no '¿' opener -> not a question.
//   * Bare shell command sigils    "$ test -f x?" — a typed command, not a query.
//   * TUI footers / chrome         the persistent hint lines ("? for shortcuts").
//   * Echoed interactive prompts   "Allow `rm -rf build`? (y/n)", "Continue? [Y/n]"
//                                  — the agent's tool asking the HUMAN, not the
//                                  agent asking the TEAM. These are handled by the
//                                  `waiting` status + narration, not the bus.
//   * Too short                    < MIN_LEN readable chars after cleaning.

import type { BoardFact } from '../store/board'
import { subjectKey } from './consensus'

/** A line shorter than this (after cleaning) can't carry a real question. */
const MIN_LEN = 10
/** Cap on the stored question text (the store caps again; this keeps it tight). */
const MAX_LEN = 160

// A genuine question: ends in '?' (optionally followed by trailing punctuation/
// whitespace) OR opens with the Spanish inverted '¿'. This is the EXACT inverse
// of insightHarvest's QUESTION_RE guard, by design.
const QUESTION_RE = /\?[\s)»"']*$|^\s*¿/

// Persistent TUI footers / chrome that happen to contain a '?'. Defense in depth
// (mirrors insightHarvest's FOOTER_RE) so a hint line is never mistaken for a
// question the agent is actually asking.
const FOOTER_RE =
  /(bypass permissions|shift\+tab to cycle|esc to interrupt|ctrl\+c to|ctrl-c to|\? for shortcuts|press \? for|to cycle\)|↑↓ to|enter to send)/i

// Bare shell command: starts with a prompt sigil. We don't want to capture a typed
// command that merely happens to contain a '?' (a glob, a test expr).
const PROMPT_SIGIL_RE = /^\s*[$#➜❯»▶]\s/

// Echoed interactive tool prompts that ask the HUMAN for a yes/no/choice — these
// are the `waiting`-status confirmations narration already surfaces, NOT a peer
// question to route through the team's knowledge. Catch the common shapes.
const INTERACTIVE_PROMPT_RE =
  /\((?:y\/n|s\/n|yes\/no|y\/n\/a)\)|\[(?:y\/n|yes\/no|y\/n\/a)\]|\((?:[1-9]\d*)\)|\(press\b|\(enter\b|\bpress (?:enter|any key)\b|\b(?:y\/n|s\/n)\b\s*$/i

// A line that's clearly an agent ASKING (vs. a quoted/echoed prompt) leans on
// first-person / deliberation cues. Not required (a bare "¿…?" / "…?" is enough),
// but used to keep precision high on borderline single-'?' lines that look like
// echoed text. EN + ES.
const ASKING_CUE_RE =
  /\b(should i|should we|do i|do we|can i|can we|which|what|where|how|why|when|who|is it|are we|shall i|shall we|debo|debemos|deber[íi]a|puedo|podemos|cu[áa]l|qu[ée]|d[óo]nde|c[óo]mo|por qu[ée]|cu[áa]ndo|qui[ée]n|uso|usamos|hago|hacemos|prefieres?|recomiendas?)\b/i

/** Collapse internal whitespace and trim. */
function squash(line: string): string {
  return (line || '').replace(/\s+/g, ' ').trim()
}

/**
 * Strip leading chrome the agent renders before real content — list bullets, tree
 * glyphs — mirroring insightHarvest.cleanLeading so the two surfaces clean lines
 * identically. Returns the cleaned line.
 */
function cleanLeading(line: string): string {
  return line.replace(/^\s*[-*•·▸▹◦‣⁃|└├─?\s]+/, '').trim()
}

/** A live, unresolved question detected from an agent's output line. */
export interface DetectedQuestion {
  /** the cleaned, capped question text. */
  text: string
  /** the consensus subjectKey() of the text, or null when none applies. A null
   *  subject still produces a valid card (it can be flagged to the human) — it
   *  simply can't be auto-matched to a fact. */
  subject: string | null
}

/**
 * Is this (already meaningful, ANSI-stripped) line a genuine agent question?
 * Pure predicate; applies the reject guards first, then requires the question
 * shape. Conservative by design (precision over recall).
 */
export function isQuestion(line: string): boolean {
  const raw = squash(line || '')
  if (!raw) return false

  // ---- reject guards (cheap, run first) ----
  if (FOOTER_RE.test(raw)) return false
  if (PROMPT_SIGIL_RE.test(raw)) return false
  if (INTERACTIVE_PROMPT_RE.test(raw)) return false

  // Must actually be question-shaped.
  if (!QUESTION_RE.test(raw)) return false

  const t = cleanLeading(raw)
  if (t.length < MIN_LEN) return false

  // A Spanish inverted-opener line is unambiguously a question. For a plain
  // trailing-'?' line we additionally require an asking cue, which screens out
  // echoed fragments that merely end in '?' without being a real query.
  if (/^\s*¿/.test(raw)) return true
  return ASKING_CUE_RE.test(t)
}

/**
 * Classify + clean. Returns { text, subject } when `line` is a genuine agent
 * question, or null otherwise. subject reuses consensus.subjectKey VERBATIM so a
 * question and a Brief Board fact agree on subjects. The caller (TerminalOverlay)
 * owns the throttle and the store write.
 */
export function detectQuestion(line: string): DetectedQuestion | null {
  if (!isQuestion(line)) return null
  let text = cleanLeading(squash(line))
  if (!text) return null
  if (text.length > MAX_LEN) text = text.slice(0, MAX_LEN - 1) + '…'
  return { text, subject: subjectKey(text) }
}

/** A ranked candidate that may answer an Open Question. */
export interface AnswerSource {
  /** 'fact' — a pinned Brief Board fact; 'agent' — a sibling agent's live lens
   *  excerpt that shares the question's subject. */
  kind: 'fact' | 'agent'
  /** the human-readable source label (the pinning agent / the sibling's title). */
  source: string
  /** the text to inject into the asking agent (the fact body, or the excerpt). */
  answer: string
  /** provenance id: the BoardFact id (kind 'fact') or the node id (kind 'agent'). */
  refId: string
  /** the recency timestamp used for ranking (ms). */
  ts: number
  /** ranking score (higher = more confident). For display/sort only. */
  score: number
}

/** A sibling agent's live lens excerpt, the minimal shape this matcher reads. */
export interface NodeExcerpt {
  nodeId: string
  title: string
  /** the agent's latest meaningful line (Agent Lens excerpt). */
  excerpt: string
  /** wall-clock ms of the excerpt. */
  ts: number
}

/**
 * Rank candidate answer-sources for a question. PURE + deterministic, precision
 * first: returns [] when the question has no subject, or when nothing shares it.
 *
 * Matching is by SHARED SUBJECT VOCABULARY — the same consensus.subjectKey() that
 * powers the Consensus Lens. A Brief Board fact answers a question when its
 * subjectKey equals the question's subject; a sibling agent answers when its live
 * lens excerpt's subjectKey equals the question's subject (and it is NOT the
 * asking node). Candidates are ranked by source priority (a durable pinned fact
 * outranks an ephemeral excerpt) then recency. The asking node never answers
 * itself.
 */
export function scoreAnswerSources(
  q: DetectedQuestion,
  facts: BoardFact[],
  nodes: NodeExcerpt[],
  askingNodeId?: string
): AnswerSource[] {
  if (!q || !q.subject) return []
  const out: AnswerSource[] = []

  // Brief Board facts that assert about the SAME subject answer the question.
  for (const f of facts || []) {
    const body = squash(f.text)
    if (!body) continue
    if (subjectKey(body) !== q.subject) continue
    const source = squash(f.sourceTitle || f.agent || '') || 'Brief Board'
    out.push({
      kind: 'fact',
      source,
      answer: body,
      refId: f.id,
      ts: f.ts,
      // Facts are durable, attributed knowledge -> highest base priority.
      score: 1000 + f.ts / 1e10
    })
  }

  // Sibling agents whose live lens excerpt is about the SAME subject can answer.
  for (const n of nodes || []) {
    if (!n) continue
    if (askingNodeId && n.nodeId === askingNodeId) continue // never self-answer
    const ex = squash(n.excerpt)
    if (!ex || ex.length < MIN_LEN) continue
    if (subjectKey(ex) !== q.subject) continue
    out.push({
      kind: 'agent',
      source: squash(n.title) || 'agente',
      answer: ex,
      refId: n.nodeId,
      ts: n.ts,
      // An ephemeral excerpt is weaker evidence than a pinned fact.
      score: 500 + n.ts / 1e10
    })
  }

  // Highest score first (priority then recency); stable on ties.
  out.sort((a, b) => b.score - a.score)
  return out
}
