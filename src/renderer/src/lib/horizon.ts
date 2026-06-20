// horizon.ts
//
// Mission Horizon — the swarm-level completion forecast (the FORWARD-LOOKING layer).
//
// Every intelligence surface CanvasIO has is PRESENT-TENSE and PER-AGENT: Mission
// Brief answers "who is blocked?", the Conductor answers "what should I do next?",
// per-node Objectives answer "is THIS agent on-track?". None of them answer the one
// question an operator running a swarm actually has: "Is my WHOLE mission going to
// finish, and WHEN?" Nothing aggregates the per-agent signals into a single mission
// state, and nothing forecasts.
//
// This module is that missing surface. Given ONE declared overarching mission goal
// plus the per-agent objective percents the canvas ALREADY computes (assessObjective)
// and the per-task work velocity Mission Pulse ALREADY records (durationMs per
// finished task), it folds them into a swarm-level readout:
//   - an aggregate % complete (mean of every objective-bearing agent's percent,
//     weighted toward critical-path agents),
//   - a predicted ETA extrapolated from median task velocity vs. the remaining
//     objective work,
//   - the single "horizon-gating" agent: the incomplete agent on the relay critical
//     path that is deciding the mission's finish time.
//
// The "gating agent" is a genuinely NEW cross-signal join (objective-incomplete ∩
// on-critical-path) that no current surface computes: the Conductor ranks
// next-actions, Critical Path finds the relay bottleneck, but neither identifies the
// agent deciding the WHOLE mission's ETA.
//
// PURITY CONTRACT (mirrors conductor.ts / missionBrief.ts / objective.ts):
//   - imports ONLY types (no zustand store, no React, no IPC, no main process),
//   - never mutates its inputs,
//   - is fully deterministic given the same inputs (trivially unit-testable),
//   - PRECISION OVER RECALL: when evidence is insufficient we return etaMs=null and
//     gatingNodeId=null — we NEVER invent a forecast.
//
// The declared goal is in-memory-only like every other intelligence surface —
// nothing here is stored or serialized.

import type { ObjectiveJudgment } from './objective'
import { t } from '../store/i18n'

/** A single agent's contribution to the mission forecast, folded from the canvas. */
export interface HorizonAgent {
  nodeId: string
  /** display title. */
  title: string
  /** 0-100 progress toward this agent's own objective (assessObjective.percent). */
  percent: number
  /** this agent's calm goal-aware judgment (assessObjective.judgment). */
  judgment: ObjectiveJudgment
  /** true when this node sits on the relay critical path (chain ∪ blocked). */
  onCritical: boolean
  /** true when this node actually carries a declared objective. */
  hasObjective: boolean
}

/** Everything computeHorizon() folds together — every field is a read of an existing
 *  in-memory surface, assembled by the store glue at call time. */
export interface HorizonInput {
  /** the ONE overarching mission goal the operator declared (empty when none). */
  goal: string
  /** per-agent objective contributions (terminals only). */
  agents: HorizonAgent[]
  /** durationMs of every FINISHED task recorded by Mission Pulse (the velocity sample). */
  finishedDurationsMs: number[]
  /** wall-clock now (injected for determinism in tests). Defaults to Date.now(). */
  now?: number
}

/** The deterministic swarm-level readout produced by computeHorizon. */
export interface HorizonForecast {
  /** the declared goal (echoed back, trimmed; empty string when none / idle). */
  goal: string
  /** true when there is no goal declared or no objective-bearing agents to forecast. */
  idle: boolean
  /** aggregate 0-100 % complete (critical-weighted mean of per-agent percents). */
  percent: number
  /** 0..1 remaining work fraction (1 - percent/100). */
  remainingFraction: number
  /**
   * predicted ms until the mission finishes, or null when there is no velocity
   * sample yet (no finished task) — precision over recall, never an invented ETA.
   */
  etaMs: number | null
  /**
   * the horizon-gating agent: the INCOMPLETE on-critical objective-bearing agent
   * with the LOWEST percent — the long pole deciding the mission's finish time.
   * null when no incomplete on-critical agent exists.
   */
  gatingNodeId: string | null
  /** the gating agent's title, for the headline (null when no gating agent). */
  gatingTitle: string | null
  /** the count of objective-bearing agents folded into the aggregate. */
  contributing: number
  /**
   * the objective-bearing agents folded into the aggregate, sorted lowest-percent
   * first (the long poles at the top) for the panel breakdown. Empty when idle.
   */
  agents: HorizonAgent[]
  /** compact Spanish headline, e.g. "68% · ~7m · falta Atlas". */
  headline: string
}

/** Critical-path agents weigh more in the aggregate: they decide the finish line. */
const CRITICAL_WEIGHT = 2
const NORMAL_WEIGHT = 1

/** A neutral, calm idle readout (no goal / nothing to forecast). */
function idleForecast(goal: string): HorizonForecast {
  return {
    goal,
    idle: true,
    percent: 0,
    remainingFraction: 1,
    etaMs: null,
    gatingNodeId: null,
    gatingTitle: null,
    contributing: 0,
    agents: [],
    headline: goal ? t('horizon.no_progress_yet') : t('horizon.no_mission_goal')
  }
}

/** Median of a numeric sample (0 when empty). Pure. */
function median(xs: number[]): number {
  const s = xs.filter((n) => Number.isFinite(n) && n > 0).sort((a, b) => a - b)
  if (s.length === 0) return 0
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

/**
 * Forecast the whole mission from the per-agent objective percents + recorded task
 * velocity. PURE + deterministic. Precision over recall: returns an idle readout
 * when there is no goal or no objective-bearing agent, and etaMs=null when there is
 * no velocity sample yet.
 *
 * Aggregate %:
 *   critical-weighted mean of every OBJECTIVE-BEARING agent's percent (agents
 *   without a declared objective are excluded — they contribute no measurable goal
 *   progress). On-critical agents count double, so the number tracks the work that
 *   actually gates the finish line.
 *
 * ETA:
 *   velocity = median of finishedDurationsMs (ms per finished task). Remaining work
 *   is estimated as the sum, over incomplete objective-bearing agents, of each
 *   agent's remaining fraction (1 - percent/100) — i.e. "how many agent-tasks worth
 *   of work is left". etaMs = medianTaskMs × estimatedRemainingTasks. Null when
 *   velocity is 0 (no finished task yet) or nothing remains.
 *
 * Gating agent:
 *   the incomplete on-critical objective-bearing agent with the LOWEST percent (the
 *   long pole). Ties break by nodeId asc for determinism. Null when none.
 */
export function computeHorizon(input: HorizonInput): HorizonForecast {
  const goal = (input.goal || '').trim()
  if (!goal) return idleForecast('')

  // Only objective-bearing agents contribute measurable goal progress.
  const bearing = input.agents.filter((a) => a.hasObjective)
  if (bearing.length === 0) return idleForecast(goal)

  // --- aggregate %: critical-weighted mean of per-agent percents ---
  let weightedSum = 0
  let weightTotal = 0
  for (const a of bearing) {
    const w = a.onCritical ? CRITICAL_WEIGHT : NORMAL_WEIGHT
    weightedSum += clampPercent(a.percent) * w
    weightTotal += w
  }
  const percent = weightTotal > 0 ? Math.round(weightedSum / weightTotal) : 0
  const remainingFraction = Math.max(0, Math.min(1, 1 - percent / 100))

  // --- remaining work: sum of per-agent remaining fractions over INCOMPLETE agents ---
  // An agent whose objective is met contributes no remaining work; others contribute
  // their own (1 - percent/100). This is "agent-tasks of work left".
  let remainingTasks = 0
  for (const a of bearing) {
    if (a.judgment === 'met' || a.percent >= 100) continue
    remainingTasks += 1 - clampPercent(a.percent) / 100
  }

  // --- velocity → ETA (null when no sample, or nothing remains) ---
  const medianTaskMs = median(input.finishedDurationsMs)
  let etaMs: number | null = null
  if (medianTaskMs > 0 && remainingTasks > 0) {
    etaMs = Math.round(medianTaskMs * remainingTasks)
  }

  // --- gating agent: lowest-percent INCOMPLETE on-critical agent ---
  let gating: HorizonAgent | null = null
  for (const a of bearing) {
    if (!a.onCritical) continue
    if (a.judgment === 'met' || a.percent >= 100) continue
    if (
      !gating ||
      clampPercent(a.percent) < clampPercent(gating.percent) ||
      (clampPercent(a.percent) === clampPercent(gating.percent) && a.nodeId < gating.nodeId)
    ) {
      gating = a
    }
  }

  const headline = buildHeadline(percent, etaMs, gating?.title ?? null)

  // Sorted breakdown for the panel: lowest-percent first (long poles on top), ties
  // by nodeId asc for determinism.
  const sortedAgents = [...bearing].sort(
    (a, b) =>
      clampPercent(a.percent) - clampPercent(b.percent) ||
      (a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0)
  )

  return {
    goal,
    idle: false,
    percent,
    remainingFraction,
    etaMs,
    gatingNodeId: gating?.nodeId ?? null,
    gatingTitle: gating?.title ?? null,
    contributing: bearing.length,
    agents: sortedAgents,
    headline
  }
}

/** Clamp a possibly-out-of-range percent into [0,100]. */
function clampPercent(p: number): number {
  if (!Number.isFinite(p)) return 0
  return Math.max(0, Math.min(100, p))
}

/** Compose the compact Spanish chip headline. Pure. */
function buildHeadline(percent: number, etaMs: number | null, gatingTitle: string | null): string {
  const parts: string[] = [`${percent}%`]
  if (etaMs != null) parts.push(`~${etaLabel(etaMs)}`)
  if (percent >= 100) {
    parts.push(t('horizon.mission_complete'))
  } else if (gatingTitle) {
    parts.push(t('horizon.waiting_on', { gatingTitle }))
  }
  return parts.join(' · ')
}

/**
 * Human-friendly short duration label (e.g. "7m", "45s", "1h12m"). Mirrors the
 * compact style Mission Pulse uses for durations. Pure.
 */
export function etaLabel(ms: number | null): string {
  if (ms == null || !Number.isFinite(ms) || ms <= 0) return '—'
  const totalSec = Math.round(ms / 1000)
  if (totalSec < 60) return `${totalSec}s`
  const totalMin = Math.round(totalSec / 60)
  if (totalMin < 60) return `${totalMin}m`
  const h = Math.floor(totalMin / 60)
  const m = totalMin % 60
  return m > 0 ? `${h}h${m}m` : `${h}h`
}

/**
 * Accent color for the Horizon readout — reuses the calm/amber/green convention
 * objective.judgmentColor / recommendationColor use. Green when essentially done,
 * calm blue while healthily in progress, amber when a clear gating long-pole remains
 * but progress is low, muted when idle.
 */
export function horizonColor(forecast: HorizonForecast): string {
  if (forecast.idle) return '#5b6887' // muted
  if (forecast.percent >= 100) return '#48d597' // green — done
  if (forecast.gatingNodeId && forecast.percent < 50) return '#f2c84b' // amber — long pole
  return '#7aa2ff' // calm blue — in progress
}
