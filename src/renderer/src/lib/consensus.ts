// consensus.ts
//
// Consensus Lens — the PURE classifier behind cross-agent agreement &
// contradiction intelligence for the Brief Board (store/board.ts).
//
// Today the Brief Board is a flat, additive pool of attributed facts: agent A
// pins "auth is a bearer token", agent B later pins "auth uses an API key", and
// the board shows BOTH side by side as if both were true. Every OTHER
// intelligence surface is either single-agent (Objective, Lens, Echo, Thermal)
// or structural (Critical Path over the relay graph, Collision Watch over file
// edits) — none reasons about the SEMANTIC consistency of the team's shared
// knowledge. This module is that missing layer.
//
// Given the board's facts, it groups them by the SUBJECT each asserts about (a
// normalized key like "auth", "api base", "db", "port", "endpoint", plus a
// "verdict" bucket for tests/build outcomes), then, within each subject and
// ONLY across DIFFERENT source agents, detects two relations:
//   * CORROBORATION — ≥2 distinct agents independently assert the SAME value.
//   * CONTRADICTION — ≥2 distinct agents assert CONFLICTING values.
//
// PURITY CONTRACT (mirrors insightHarvest.ts / objective.ts / criticalPath.ts):
//   - imports ONLY a type (BoardFact); no zustand store, no React, no IPC,
//   - never mutates its inputs, fully deterministic, trivially unit-testable,
//   - precision over recall: when a fact's subject or value is ambiguous, it is
//     OMITTED — we NEVER invent a conflict. A single agent revising its own claim
//     (same agent, two values) is NOT a contradiction.
//
// The derived readout is in-memory-only, like every other intelligence surface —
// nothing here is stored or serialized. The EN+ES keyword vocabulary mirrors
// insightHarvest's so the two surfaces agree on what a "subject" is.

import type { BoardFact } from '../store/board'

// ---- subject vocabulary (EN + ES), precision-first --------------------------
//
// Each subject is a normalized key with a list of cue regexes. Order matters:
// the FIRST subject whose cue matches wins, so put the more specific subjects
// (api base, endpoint) before the broader ones. Cues are word-bounded to avoid
// matching inside unrelated tokens.

interface SubjectDef {
  key: string
  cues: RegExp[]
}

const SUBJECTS: SubjectDef[] = [
  {
    key: 'auth',
    cues: [/\bauth(?:entication|orization)?\b/i, /\bbearer\b/i, /\btoken\b/i, /\bapi key\b/i, /\bautenticaci[óo]n\b/i, /\bclave\b/i]
  },
  {
    key: 'api base',
    cues: [/\bapi base\b/i, /\bbase ?url\b/i, /\bbase\b/i, /\bbase de la api\b/i]
  },
  {
    key: 'endpoint',
    cues: [/\bendpoint\b/i, /\broute\b/i, /\bruta\b/i, /\bpath\b/i]
  },
  {
    key: 'db',
    cues: [/\bdatabase\b/i, /\bdb\b/i, /\bpostgres(?:ql)?\b/i, /\bmysql\b/i, /\bsqlite\b/i, /\bmongo(?:db)?\b/i, /\bredis\b/i, /\bbase de datos\b/i]
  },
  {
    key: 'port',
    cues: [/\bport\b/i, /\bpuerto\b/i]
  }
]

// A verdict subject is special: it has TWO opposing polarities (pass vs fail),
// and the "value" we compare is the polarity, not a free token.
const VERDICT_PASS_RE =
  /\b(tests?\s+(?:pass(?:ed|es)?)|all\s+(?:\d+\s+)?tests?\s+pass(?:ed)?|build\s+(?:succeed(?:ed)?|pass(?:ed)?|ok|green)|compil(?:es|ed)\s+(?:successfully|ok|clean)|green\b|pruebas?\s+(?:pasan|pasaron)|compila\s+(?:bien|correctamente|ok)|todo\s+verde|build\s+ok)\b/i
const VERDICT_FAIL_RE =
  /\b(tests?\s+fail(?:ed|s)?|build\s+(?:fail(?:ed|s)?|broke|broken|red)|compil(?:e|ation)\s+(?:error|failed)|red\b|pruebas?\s+(?:fallan|fallaron)|build\s+failed|no\s+compila)\b/i

/** Collapse internal whitespace and trim. */
function squash(line: string): string {
  return (line || '').replace(/\s+/g, ' ').trim()
}

/**
 * Normalize a fact's text to its SUBJECT key, or null when none applies.
 * Verdicts (tests/build outcomes) map to the single 'verdict' subject. Returns
 * the first matching subject in declaration order (specific before broad), so a
 * fact mentioning both is bucketed by the most specific cue. Pure + deterministic.
 */
export function subjectKey(text: string): string | null {
  const t = squash(text)
  if (!t) return null
  if (VERDICT_PASS_RE.test(t) || VERDICT_FAIL_RE.test(t)) return 'verdict'
  for (const s of SUBJECTS) {
    for (const cue of s.cues) {
      if (cue.test(t)) return s.key
    }
  }
  return null
}

// Value extractors. For most subjects the asserted value is a concrete token:
// a path (/v2, /login), an identifier (postgres, bearer), a number (3000). We
// pull the MOST value-shaped token after a copula/cue when we can, else the
// strongest value-shaped token in the line. When nothing concrete is found, we
// return '' so the caller can OMIT the fact (precision over recall).

// A value-shaped token: a path, a dotted/identifier word, or a number. We avoid
// matching common filler words by requiring path/digit/length shape.
const PATH_RE = /\/[\w@.\-/]*[\w\d]/ // "/v2", "/api/login"
const NUMBER_RE = /\b\d{2,5}\b/ // "3000", "8080", "5432"
const QUOTED_RE = /["'`]([^"'`]{1,40})["'`]/ // `bearer`, "api key"

// Known canonical value words per subject (for normalization so "bearer token"
// and "a bearer" collapse to the same value). These are precision aids only.
const AUTH_VALUE_RE = /\b(bearer|api[\s-]?key|oauth|jwt|basic|cookie|session)\b/i
const DB_VALUE_RE = /\b(postgres(?:ql)?|mysql|sqlite|mongo(?:db)?|redis)\b/i

/**
 * Extract the claimed VALUE for a fact, given its subject. Returns a normalized,
 * lowercased value token, or '' when no concrete value can be pulled (the caller
 * then omits the fact — we never compare two empty values). Pure + deterministic.
 */
export function assertedValue(text: string, subject: string): string {
  const t = squash(text)
  if (!t) return ''

  if (subject === 'verdict') {
    // Polarity IS the value. A line that somehow matches both is ambiguous -> ''.
    const pass = VERDICT_PASS_RE.test(t)
    const fail = VERDICT_FAIL_RE.test(t)
    if (pass && fail) return ''
    if (pass) return 'pass'
    if (fail) return 'fail'
    return ''
  }

  if (subject === 'auth') {
    const m = t.match(AUTH_VALUE_RE)
    if (m) return m[1].toLowerCase().replace(/[\s-]/g, '')
    // fall through to generic shapes (e.g. a quoted scheme name)
  }

  if (subject === 'db') {
    const m = t.match(DB_VALUE_RE)
    if (m) return m[1].toLowerCase()
  }

  if (subject === 'port') {
    const m = t.match(NUMBER_RE)
    if (m) return m[0]
    return ''
  }

  // Generic: prefer a path (api base / endpoint), then a quoted snippet, then a
  // bare value-shaped identifier/number.
  const path = t.match(PATH_RE)
  if (path) return path[0].toLowerCase()
  const quoted = t.match(QUOTED_RE)
  if (quoted) return quoted[1].toLowerCase().trim()
  const num = t.match(NUMBER_RE)
  if (num) return num[0]
  return ''
}

/** One subject where ≥2 distinct agents asserted the SAME value. */
export interface Corroboration {
  subject: string
  value: string
  /** distinct source agents that agree, in first-seen order. */
  agents: string[]
  /** ids of every fact that contributed (for inline badge mapping). */
  factIds: string[]
}

/** One subject where distinct agents asserted CONFLICTING values. */
export interface Conflict {
  subject: string
  /** the conflicting claims, one per distinct agent (first value they asserted). */
  claims: { agent: string; value: string; factId: string }[]
}

/** The full cross-agent readout produced by analyzeConsensus. */
export interface ConsensusReadout {
  corroborated: Corroboration[]
  conflicts: Conflict[]
}

const EMPTY: ConsensusReadout = { corroborated: [], conflicts: [] }

/** A fact's attribution agent, normalized; '' when unknown (then it can't vote). */
function agentOf(f: BoardFact): string {
  return squash(f.sourceTitle || f.agent || '')
}

/**
 * Classify the board into corroborations and conflicts. PURE + deterministic.
 *
 * Algorithm (precision-first):
 *   1. For each fact, derive (subject, value, agent). Drop any fact missing any
 *      of the three (unknown subject, no concrete value, or no attribution) —
 *      such a fact can neither corroborate nor contradict.
 *   2. Group surviving facts by subject.
 *   3. Within a subject, collapse to ONE claim per distinct agent (first value
 *      that agent asserted; a single agent revising itself does NOT create a
 *      conflict because it contributes a single claim).
 *   4. If ≥2 distinct agents share the SAME value -> a Corroboration for that
 *      value (its agents + every contributing factId).
 *      If ≥2 distinct agents hold DIFFERENT values -> a Conflict listing one
 *      claim per disagreeing agent. A subject with only one distinct agent (or
 *      one distinct value) yields neither.
 */
export function analyzeConsensus(facts: BoardFact[]): ConsensusReadout {
  if (!facts || facts.length === 0) return EMPTY

  // subject -> ordered list of contributing claims
  interface Claim {
    agent: string
    value: string
    factId: string
  }
  const bySubject = new Map<string, Claim[]>()

  for (const f of facts) {
    const subject = subjectKey(f.text)
    if (!subject) continue
    const value = assertedValue(f.text, subject)
    if (!value) continue
    const agent = agentOf(f)
    if (!agent) continue
    const list = bySubject.get(subject) || []
    list.push({ agent, value, factId: f.id })
    bySubject.set(subject, list)
  }

  const corroborated: Corroboration[] = []
  const conflicts: Conflict[] = []

  for (const [subject, claims] of bySubject) {
    // One claim per distinct agent: first value an agent asserted wins, but we
    // still collect EVERY contributing factId per (agent,value) for badge mapping.
    const firstValueByAgent = new Map<string, string>()
    const factIdsByValue = new Map<string, string[]>()
    const agentsByValue = new Map<string, string[]>()

    for (const c of claims) {
      if (!firstValueByAgent.has(c.agent)) firstValueByAgent.set(c.agent, c.value)
      const v = firstValueByAgent.get(c.agent)!
      // Only fold facts that match the agent's FIRST (canonical) value, so a
      // self-revision's later value doesn't pollute the corroboration set.
      if (c.value === v) {
        const ids = factIdsByValue.get(v) || []
        ids.push(c.factId)
        factIdsByValue.set(v, ids)
        const ags = agentsByValue.get(v) || []
        if (!ags.includes(c.agent)) ags.push(c.agent)
        agentsByValue.set(v, ags)
      }
    }

    const distinctAgents = firstValueByAgent.size
    if (distinctAgents < 2) continue // need ≥2 agents to corroborate or conflict

    const distinctValues = new Set(firstValueByAgent.values())

    if (distinctValues.size === 1) {
      // All agents agree -> corroboration.
      const value = distinctValues.values().next().value as string
      corroborated.push({
        subject,
        value,
        agents: agentsByValue.get(value) || [],
        factIds: factIdsByValue.get(value) || []
      })
    } else {
      // ≥2 distinct values across ≥2 agents -> contradiction. Emit one claim per
      // disagreeing agent (their canonical value + a representative factId).
      const repFactId = new Map<string, string>() // agent -> a factId
      for (const c of claims) {
        if (c.value === firstValueByAgent.get(c.agent) && !repFactId.has(c.agent)) {
          repFactId.set(c.agent, c.factId)
        }
      }
      const claimsOut: Conflict['claims'] = []
      for (const [agent, value] of firstValueByAgent) {
        claimsOut.push({ agent, value, factId: repFactId.get(agent) || '' })
      }
      conflicts.push({ subject, claims: claimsOut })
    }
  }

  if (corroborated.length === 0 && conflicts.length === 0) return EMPTY
  return { corroborated, conflicts }
}

/**
 * Build a single-line, terminal-safe reconcile prompt for ONE conflict, in the
 * style of boardFormat.formatBoardForInjection (no embedded newline — the relay
 * drain submits with a trailing '\r'). Attributes both conflicting claims so the
 * target agent knows WHO asserted WHAT. Pure; the caller delivers it.
 */
export function formatReconcilePrompt(conflict: Conflict): string {
  if (!conflict || conflict.claims.length < 2) return ''
  const parts = conflict.claims.map((c) => `${c.agent} dice "${c.value}"`)
  return (
    `Conflicto de consenso sobre ${conflict.subject}: ${parts.join(' vs ')}. ` +
    `Revisa ambas afirmaciones y determina cuál es correcta (o reconcília las), ` +
    `explicando brevemente por qué.`
  )
}
