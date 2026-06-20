// scorecard.ts
//
// Agent Scorecard — Cross-Mission Reliability Intelligence (the LEARNING layer).
//
// Every other intelligence surface in CanvasIO is DESCRIPTIVE about the PRESENT
// mission and forgets everything on relaunch. Mission Pulse already records, at
// one chokepoint, every per-node transition tagged with agent kind + outcome
// (done / error / waiting) + durationMs — but those outcomes evaporate. The
// Scorecard is the missing learning layer: a tiny PERSISTED per-AgentKind track
// record (completions / errors / stalls / median time-to-done) accumulated across
// EVERY mission you ever run. It turns CanvasIO from a tool that WATCHES agents
// into one that LEARNS which agents are actually reliable.
//
// PURITY CONTRACT (mirrors conductor.ts / consensus.ts / criticalPath.ts):
//   - imports ONLY the AgentKind type (no zustand store, no React, no IPC),
//   - never mutates its inputs,
//   - is fully deterministic given the same inputs (trivially unit-testable),
//   - precision over recall: a persona with too few samples is 'insufficient data'
//     and is NEVER ranked above one that has real evidence — we never invent a
//     winner. recommendBetterKind() returns a suggestion ONLY when the gap is
//     decisive.
//
// The store/scorecard.ts glue owns persistence + event folding; this module is the
// pure ranker that two EXISTING read-only surfaces (Conductor, Recipe picker)
// consume.

import type { AgentKind } from '../store/canvas'

/** The four personas the canvas can spawn, in a stable display order. */
export const AGENT_KINDS: AgentKind[] = ['claude', 'codex', 'cursor', 'shell']

/** A single persona's accumulated track record. Folded incrementally by the store
 *  from Mission Pulse outcomes; pure data here. */
export interface AgentStat {
  kind: AgentKind
  /** completions: transitions that reached 'done'. */
  done: number
  /** errors: transitions that ended in 'error'. */
  error: number
  /** stalls: waiting-without-resolution episodes (deferred in v1 → usually 0). */
  stall: number
  /** median ms-to-done across recorded completions (0 when no timed completions). */
  medianDoneMs: number
}

/** A persona's computed reliability ranking row. */
export interface ScoreRow {
  kind: AgentKind
  /** total outcome samples (done + error + stall) — the evidence weight. */
  samples: number
  /** done / (done + error + stall) in [0,1]; 0 when no samples. */
  successRate: number
  /** the leverage-weighted reliability score (higher = more reliable). */
  score: number
  /** median ms-to-done (carried through from the stat for display). */
  medianDoneMs: number
  /**
   * true when this persona has too few samples to be trusted. An insufficient-data
   * row is NEVER ranked above a row that has evidence (precision over recall).
   */
  insufficient: boolean
}

/** The full ranked readout. `ranked` is sorted best-first; insufficient-data rows
 *  always sink below any row with evidence. */
export interface Scorecard {
  ranked: ScoreRow[]
  /** quick lookup by kind. */
  byKind: Record<AgentKind, ScoreRow>
}

/** Minimum outcome samples before a persona's record is considered trustworthy.
 *  Below this, the row is flagged 'insufficient' and parked at the bottom. */
export const MIN_SAMPLES = 4

/** How decisively better a candidate must be before recommendBetterKind() speaks:
 *  it must out-rate the current kind by at least this margin AND clear MIN_SAMPLES.
 *  Precision over recall — a marginal edge stays silent. */
const DECISIVE_RATE_GAP = 0.25

/** An empty stat for a kind with no recorded outcomes. */
export function emptyStat(kind: AgentKind): AgentStat {
  return { kind, done: 0, error: 0, stall: 0, medianDoneMs: 0 }
}

/**
 * Compute a single persona's leverage-weighted reliability score from its stat.
 *
 * The model rewards completions and penalizes errors + stalls, normalized by total
 * evidence so a persona with 8/10 done isn't beaten by one with 2/2 done that has
 * far less proof. A small speed nudge favors agents that reach done faster, but is
 * capped so it can never outweigh raw reliability (precision over recall: getting
 * it DONE matters more than getting it done FAST). Deterministic + side-effect-free.
 */
function scoreOf(stat: AgentStat, fastestMedian: number): number {
  const samples = stat.done + stat.error + stat.stall
  if (samples <= 0) return 0
  const successRate = stat.done / samples
  // Base reliability in [0,100]. Stalls weigh like a soft error (half).
  const base = (stat.done - stat.error - stat.stall * 0.5) / samples
  let score = Math.max(0, base) * 100
  // Speed nudge: up to +8 for the fastest persona that actually completes work.
  // Bounded so it never flips a reliability ordering.
  if (stat.medianDoneMs > 0 && fastestMedian > 0) {
    score += 8 * (fastestMedian / stat.medianDoneMs)
  }
  // Reward raw success rate a touch so two equal-base personas split on rate.
  score += successRate * 4
  return score
}

/**
 * Rank the four personas by leverage-weighted reliability. PURE + deterministic.
 *
 * Ordering rules (in strict priority):
 *   1) rows WITH evidence (>= MIN_SAMPLES) always rank above 'insufficient' rows,
 *   2) within each tier, higher score first,
 *   3) tie-break by success rate desc, then sample count desc, then kind order asc
 *      (stable, AGENT_KINDS order) — fully deterministic for React keys + display.
 */
export function computeScorecard(stats: AgentStat[]): Scorecard {
  // Index incoming stats by kind, filling any missing persona with an empty stat
  // so the readout always covers all four (a never-run persona reads as 0/0).
  const byKindStat = new Map<AgentKind, AgentStat>()
  for (const s of stats) byKindStat.set(s.kind, s)

  const fastestMedian = stats.reduce((m, s) => {
    if (s.medianDoneMs > 0 && (m === 0 || s.medianDoneMs < m)) return s.medianDoneMs
    return m
  }, 0)

  const rows: ScoreRow[] = AGENT_KINDS.map((kind) => {
    const stat = byKindStat.get(kind) ?? emptyStat(kind)
    const samples = stat.done + stat.error + stat.stall
    const successRate = samples > 0 ? stat.done / samples : 0
    return {
      kind,
      samples,
      successRate,
      score: scoreOf(stat, fastestMedian),
      medianDoneMs: stat.medianDoneMs,
      insufficient: samples < MIN_SAMPLES
    }
  })

  const orderIndex = (k: AgentKind): number => AGENT_KINDS.indexOf(k)

  rows.sort((a, b) => {
    // (1) evidence tier dominates: a trusted row always beats an insufficient one.
    if (a.insufficient !== b.insufficient) return a.insufficient ? 1 : -1
    // (2) score desc.
    if (b.score !== a.score) return b.score - a.score
    // (3) success rate desc, then sample count desc, then stable kind order.
    if (b.successRate !== a.successRate) return b.successRate - a.successRate
    if (b.samples !== a.samples) return b.samples - a.samples
    return orderIndex(a.kind) - orderIndex(b.kind)
  })

  const byKind = {} as Record<AgentKind, ScoreRow>
  for (const r of rows) byKind[r.kind] = r
  return { ranked: rows, byKind }
}

/** The reliability row for a single persona (defensive: always defined). */
export function reliabilityFor(kind: AgentKind, scorecard: Scorecard): ScoreRow {
  return scorecard.byKind[kind] ?? {
    kind,
    samples: 0,
    successRate: 0,
    score: 0,
    medianDoneMs: 0,
    insufficient: true
  }
}

/**
 * Given the persona CURRENTLY on a struggling node, return a clearly-better
 * persona to try instead — or null when there is no decisive winner.
 *
 * PRECISION OVER RECALL. We speak ONLY when ALL hold:
 *   - the candidate has real evidence (>= MIN_SAMPLES) — never recommend a guess,
 *   - the candidate's success rate beats the current kind's by >= DECISIVE_RATE_GAP,
 *   - the candidate is a different persona than the current one.
 * Otherwise we stay silent (return null) — a marginal or unproven edge is noise.
 */
export function recommendBetterKind(
  currentKind: AgentKind,
  scorecard: Scorecard
): ScoreRow | null {
  const current = reliabilityFor(currentKind, scorecard)
  let best: ScoreRow | null = null
  for (const row of scorecard.ranked) {
    if (row.kind === currentKind) continue
    if (row.insufficient) continue // never recommend an unproven persona
    if (row.successRate - current.successRate < DECISIVE_RATE_GAP) continue
    if (!best || row.score > best.score) best = row
  }
  return best
}
