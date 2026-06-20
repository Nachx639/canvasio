// conductor.ts
//
// The Conductor — Next-Best-Action Intelligence (the PRESCRIPTIVE layer).
//
// Every intelligence surface CanvasIO has built is DESCRIPTIVE: Mission Brief
// tells you who's blocked, Objectives tell you who's drifting, Consensus tells
// you who contradicts whom, Critical Path tells you the bottleneck, the attention
// queue tells you who needs you. The operator still has to read ALL of it and
// decide what to actually DO. This module is the missing prescriptive layer: a
// single pure reasoner that folds every existing in-memory signal into ONE ranked
// list of the highest-leverage actions to take RIGHT NOW.
//
// It is the FIRST surface that reasons ACROSS the isolated intelligence surfaces
// (attention tiers, critical-path centrality, objective drift, consensus
// conflicts, relay readiness) and ranks them against each other by LEVERAGE — a
// blocked agent that is ALSO the critical-path bottleneck outranks a blocked leaf.
//
// PURITY CONTRACT (mirrors missionBrief.ts / objective.ts / consensus.ts /
// criticalPath.ts):
//   - imports ONLY types (no zustand store, no React, no IPC, no main process),
//   - never mutates its inputs,
//   - is fully deterministic given the same inputs (trivially unit-testable),
//   - precision over recall: when a signal is ambiguous, the recommendation is
//     OMITTED — we never invent an action.
//
// The derived readout is in-memory-only like every other intelligence surface —
// nothing here is stored or serialized.

import type { CriticalPath } from './criticalPath'
import type { ConsensusReadout } from './consensus'
import type { ObjectiveJudgment } from './objective'
import type { AgentKind } from '../store/canvas'
import { recommendBetterKind, type Scorecard } from './scorecard'
import { t } from '../store/i18n'

/** What kind of next-action a recommendation prescribes. */
export type RecommendationKind =
  | 'resolve-error' // an agent is in error (highest urgency)
  | 'confirm-relay' // a finished source has un-fired downstream targets waiting on its baton
  | 'unblock-waiting' // an agent is waiting on YOU (needs a confirmation)
  | 'review-drift' // an agent is drifting / idle off its objective
  | 'reconcile-conflict' // the Brief Board has a live cross-agent contradiction
  | 'service-done' // an agent finished and wants acknowledgement

/** The one-key action a recommendation carries (routes through existing store actions). */
export type ActionKind = 'fly' | 'attention' | 'open-board' | 'open-critical' | 'none'

/** A single ranked next-best-action. */
export interface Recommendation {
  /** stable id (kind + nodeId/subject) for React keys + dedupe. */
  id: string
  kind: RecommendationKind
  /** the node this action is about, when node-scoped. */
  nodeId?: string
  /** short human-facing title (the action headline). */
  title: string
  /** one-line WHY this is the next best thing. */
  reason: string
  /** leverage score; higher = act sooner. */
  score: number
  /** label for the one-key action button ("Ir", "Confirmar relevo", …). */
  actionLabel: string
  /** which existing store action the chip/panel should dispatch. */
  actionKind: ActionKind
  /**
   * Optional 'prefer-reliable' hint from the Agent Scorecard: when a node is in
   * 'resolve-error' for a persona that the cross-mission track record shows is
   * DECISIVELY less reliable than another, this carries a quiet suggestion (e.g.
   * "claude termina más a menudo que codex en tus misiones"). Purely additive — a
   * non-breaking optional field that existing consumers simply ignore. NEVER alters
   * the recommendation's ranking or action.
   */
  hint?: string
}

/** A single agent's live snapshot, folded from the canvas + mission timeline. */
export interface AgentSnapshot {
  nodeId: string
  /** display title. */
  title: string
  /** the agent persona, when this terminal has one — lets the Conductor cross-check
   *  the node against the Agent Scorecard's per-kind track record. Optional so a
   *  persona-less node degrades cleanly (no hint). */
  kind?: AgentKind
  /** current live canvas status. */
  status: 'idle' | 'working' | 'done' | 'error'
  /** the latest mission-event kind for this node, if any. */
  lastKind?: 'spawn' | 'work-start' | 'done' | 'error' | 'waiting' | 'relay' | 'close'
  /** wall-clock ts of that latest event (0 when none). */
  lastTs: number
  /** the goal-vs-actual judgment from assessObjective, when an objective is set. */
  objective?: ObjectiveJudgment
}

/** A finished source whose baton has un-fired downstream targets (relay-ready). */
export interface RelayReady {
  /** the finished source node id. */
  sourceId: string
  /** how many downstream targets are still armed (waiting on its baton). */
  waiting: number
}

/** Everything recommend() folds together — every field is a read of an existing
 *  in-memory surface, assembled by the store glue at call time. */
export interface ConductorInput {
  /** live agent snapshots (terminals only). */
  agents: AgentSnapshot[]
  /** the pure Critical Path readout (relay bottleneck + blocked agents). */
  critical: CriticalPath
  /** the pure Consensus readout (Brief Board corroborations + conflicts). */
  consensus: ConsensusReadout
  /** finished sources with un-fired downstream relay targets. */
  relayReady: RelayReady[]
  /**
   * OPTIONAL cross-mission Agent Scorecard. When present, recommend() attaches a
   * quiet 'prefer-reliable' hint to an error recommendation whose persona is
   * decisively out-performed by another. Omitting it (or passing undefined) yields
   * the exact same recommendations as before — purely additive, never required.
   */
  scorecard?: Scorecard
  /** wall-clock now (injected for determinism in tests). Defaults to Date.now(). */
  now?: number
}

/** Hard cap on the surfaced queue so the panel stays a compact, scannable list. */
const MAX_RECOMMENDATIONS = 6

// --- per-kind base scores ----------------------------------------------------
// Errors are the most urgent (a stuck agent burns the operator's whole mission),
// then relay readiness (a finished agent gating others is pure throughput), then
// a direct "needs you" wait, then drift (soft), then a board contradiction (it
// quietly corrupts shared context but isn't time-critical), then a plain done.
const BASE: Record<RecommendationKind, number> = {
  'resolve-error': 100,
  'confirm-relay': 70,
  'unblock-waiting': 60,
  'review-drift': 40,
  'reconcile-conflict': 35,
  'service-done': 20
}

/** Leverage multiplier when a node ALSO sits on the critical path / is the
 *  bottleneck — the cross-signal reasoning that makes the Conductor a strict
 *  superset of a status-only triage. */
const BOTTLENECK_BONUS = 30
const ON_CRITICAL_BONUS = 12

/**
 * Fold every existing in-memory signal into ONE ranked list of next-best-actions.
 * PURE + deterministic. Precision over recall: ambiguous signals are omitted.
 *
 * Scoring composes the existing derivations:
 *   - attention tiers (error > waiting > done) set the base urgency,
 *   - the critical-path bottleneck / membership adds a leverage multiplier so a
 *     blocked agent that ALSO gates the most downstream work outranks a blocked
 *     leaf,
 *   - objective drift/idle surfaces a soft "look in" below the hard blockers,
 *   - a finished source with un-fired downstream targets becomes "confirm relay",
 *   - a cross-agent board contradiction becomes "reconcile conflict".
 *
 * Tie-breaks are pure: score desc, then kind order, then nodeId/id asc — stable
 * ordering for the chip head + panel list.
 */
export function recommend(input: ConductorInput): Recommendation[] {
  const bottleneckId = input.critical.bottleneckId
  const onCritical = new Set<string>(input.critical.chain)
  // Every blocked target also counts as "on the critical structure" for leverage.
  for (const b of input.critical.blocked) onCritical.add(b.nodeId)

  const byId = new Map<string, AgentSnapshot>()
  for (const a of input.agents) byId.set(a.nodeId, a)

  const recs: Recommendation[] = []

  // Leverage helper: a node-scoped recommendation gets a bonus when the node sits
  // on the critical path, and a bigger one when it IS the bottleneck.
  const leverage = (nodeId?: string): number => {
    if (!nodeId) return 0
    let bonus = 0
    if (nodeId === bottleneckId) bonus += BOTTLENECK_BONUS
    else if (onCritical.has(nodeId)) bonus += ON_CRITICAL_BONUS
    return bonus
  }

  // (1) ERROR — every errored agent is a hard blocker. A blocked-AND-bottleneck
  //     error is the single most important thing on the board.
  for (const a of input.agents) {
    if (a.status !== 'error' && a.lastKind !== 'error') continue
    const isBottleneck = a.nodeId === bottleneckId
    const reason = isBottleneck
      ? t('conductor.error_reason_bottleneck', { title: a.title })
      : t('conductor.error_reason', { title: a.title })
    // Agent Scorecard cross-check: when this errored node's persona is decisively
    // less reliable than another across your past missions, attach a quiet hint.
    // Purely informational — it never changes the score, action, or ordering.
    let hint: string | undefined
    if (input.scorecard && a.kind) {
      const better = recommendBetterKind(a.kind, input.scorecard)
      if (better) {
        const pct = Math.round(better.successRate * 100)
        hint = t('conductor.prefer_reliable_hint', {
          better: better.kind,
          current: a.kind,
          pct
        })
      }
    }
    recs.push({
      id: `resolve-error:${a.nodeId}`,
      kind: 'resolve-error',
      nodeId: a.nodeId,
      title: t('conductor.error_title', { title: a.title }),
      reason,
      score: BASE['resolve-error'] + leverage(a.nodeId),
      actionLabel: t('conductor.action_go'),
      actionKind: 'fly',
      hint
    })
  }

  // (2) CONFIRM RELAY — a finished source whose downstream targets are still
  //     armed (waiting on its baton). Confirming/looking-in releases that work.
  for (const r of input.relayReady) {
    const a = byId.get(r.sourceId)
    if (!a) continue
    // Precision: only when the source actually finished (done) — a still-working
    // or errored source isn't relay-ready (the error case is handled above).
    if (a.status !== 'done' && a.lastKind !== 'done') continue
    if (r.waiting <= 0) continue
    const reason =
      r.waiting === 1
        ? t('conductor.relay_reason_one', { title: a.title })
        : t('conductor.relay_reason_other', { title: a.title, count: r.waiting })
    recs.push({
      id: `confirm-relay:${r.sourceId}`,
      kind: 'confirm-relay',
      nodeId: r.sourceId,
      title: t('conductor.relay_title', { title: a.title }),
      reason,
      score: BASE['confirm-relay'] + leverage(r.sourceId) + Math.min(20, r.waiting * 6),
      actionLabel: t('conductor.action_go'),
      actionKind: 'fly'
    })
  }

  // (3) UNBLOCK WAITING — an agent that is waiting on YOU (a confirmation). These
  //     are the "te necesita" tier; a waiting agent on the critical path outranks
  //     a waiting leaf.
  for (const a of input.agents) {
    if (a.lastKind !== 'waiting') continue
    // An errored node is already covered by (1); don't double-recommend.
    if (a.status === 'error') continue
    recs.push({
      id: `unblock-waiting:${a.nodeId}`,
      kind: 'unblock-waiting',
      nodeId: a.nodeId,
      title: t('conductor.waiting_title', { title: a.title }),
      reason: t('conductor.waiting_reason', { title: a.title }),
      score: BASE['unblock-waiting'] + leverage(a.nodeId),
      actionLabel: t('conductor.action_go'),
      actionKind: 'fly'
    })
  }

  // (4) REVIEW DRIFT — an agent busy but drifting off its objective (soft signal).
  //     Idle-with-an-objective is a weaker variant of the same "look in".
  for (const a of input.agents) {
    if (a.objective !== 'drifting' && a.objective !== 'idle') continue
    // Don't surface drift for a node that's already a hard blocker (error/waiting):
    // those outrank it and re-recommending the same node adds noise.
    if (a.status === 'error' || a.lastKind === 'error' || a.lastKind === 'waiting') continue
    const drifting = a.objective === 'drifting'
    recs.push({
      id: `review-drift:${a.nodeId}`,
      kind: 'review-drift',
      nodeId: a.nodeId,
      title: t('conductor.drift_title', { title: a.title }),
      reason: drifting
        ? t('conductor.drift_reason_drifting', { title: a.title })
        : t('conductor.drift_reason_idle', { title: a.title }),
      // Idle is softer than active drift.
      score: BASE['review-drift'] + leverage(a.nodeId) - (drifting ? 0 : 8),
      actionLabel: t('conductor.action_go'),
      actionKind: 'fly'
    })
  }

  // (5) RECONCILE CONFLICT — a live cross-agent contradiction on the Brief Board.
  //     Not node-scoped (it's a board fact), so it opens the board lens. analyze
  //     Consensus already guarantees ≥2 DISTINCT agents disagree, so emitting one
  //     recommendation per conflict subject is precision-safe.
  for (const c of input.consensus.conflicts) {
    if (c.claims.length < 2) continue
    const names = c.claims.map((cl) => cl.agent).slice(0, 2).join(' vs ')
    recs.push({
      id: `reconcile-conflict:${c.subject}`,
      kind: 'reconcile-conflict',
      title: t('conductor.conflict_title', { subject: c.subject }),
      reason: t('conductor.conflict_reason', { subject: c.subject, names }),
      score: BASE['reconcile-conflict'] + Math.min(10, (c.claims.length - 2) * 3),
      actionLabel: t('conductor.action_open_board'),
      actionKind: 'open-board'
    })
  }

  // (6) SERVICE DONE — a finished agent that has NO pending relay (covered above)
  //     still wants acknowledgement so it leaves the attention queue. Lowest tier.
  for (const a of input.agents) {
    if (a.lastKind !== 'done') continue
    if (a.status === 'error') continue
    // Skip when it's already a relay-ready confirm (don't double-recommend).
    const relayReady = input.relayReady.some((r) => r.sourceId === a.nodeId && r.waiting > 0)
    if (relayReady) continue
    recs.push({
      id: `service-done:${a.nodeId}`,
      kind: 'service-done',
      nodeId: a.nodeId,
      title: t('conductor.done_title', { title: a.title }),
      reason: t('conductor.done_reason', { title: a.title }),
      score: BASE['service-done'] + leverage(a.nodeId),
      actionLabel: t('conductor.action_go'),
      actionKind: 'fly'
    })
  }

  // Deterministic ordering: score desc, then kind base desc, then id asc.
  recs.sort(
    (x, y) =>
      y.score - x.score ||
      BASE[y.kind] - BASE[x.kind] ||
      (x.id < y.id ? -1 : x.id > y.id ? 1 : 0)
  )

  return recs.slice(0, MAX_RECOMMENDATIONS)
}

/** Accent color per recommendation kind — reuses the calm/amber/green/red
 *  convention TriageChip / objective.judgmentColor use, for the chip + panel. */
export function recommendationColor(kind: RecommendationKind): string {
  switch (kind) {
    case 'resolve-error':
      return '#ff6b6b' // red
    case 'confirm-relay':
      return '#9b8cff' // violet (matches Critical Path)
    case 'unblock-waiting':
      return '#5ad1e8' // cyan (matches Triage waiting)
    case 'review-drift':
      return '#f2c84b' // amber
    case 'reconcile-conflict':
      return '#f29bff' // magenta (matches Consensus)
    case 'service-done':
    default:
      return '#48d597' // green
  }
}
