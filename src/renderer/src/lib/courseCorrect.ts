// courseCorrect.ts
//
// Course Correct — the PURE reasoner that closes the only open loop in CanvasIO's
// intelligence stack. Every other surface OBSERVES agents and then tells the human
// (Mission Brief, Conductor, Consensus, Critical Path) or moves the camera
// (Director, Replay, Tour, Stages). Knowledge only ever flows back INTO an agent
// at spawn (Recall / Brief Board injection) or via statically pre-wired Agent Relay
// handoffs. Nothing notices, WHILE an agent is running, that the team has just
// learned something that contradicts what that agent is doing and feeds a
// correction back to it. This module computes those corrections.
//
// It joins three EXISTING signals (all read by the store glue, passed here as plain
// data):
//   * Consensus CONFLICTS (lib/consensus.ts) — each conflicting claim attributed to
//     a specific agent + value + factId.
//   * Brief Board facts (store/board.ts) — each fact's sourceNodeId (provenance).
//   * Live canvas nodes (store/canvas.ts) — node id + title + status.
//
// For each conflict it maps each claim.factId -> the fact's sourceNodeId, then keeps
// only claims whose node is STILL a live terminal that can act (status idle/working).
// It emits a CourseCorrection only for a SINGLE still-running minority claimant whose
// value differs from a distinct, clear team value (the majority of the OTHER agents).
// Precision over recall: when the team value is ambiguous (no single distinct
// counter-value), or there is not exactly one live minority claimant, it is OMITTED —
// we never invent a nudge.
//
// PURITY CONTRACT (mirrors consensus.ts / conductor.ts / criticalPath.ts):
//   - imports ONLY types; no zustand store, no React, no IPC,
//   - never mutates its inputs, fully deterministic, trivially unit-testable.
// The derived readout is in-memory-only; nothing here is stored or serialized.

import type { Conflict } from './consensus'
import { t } from '../store/i18n'

/** A live terminal node the reasoner can target, narrowed to what it needs. */
export interface LiveNode {
  id: string
  title: string
  /** the live status; only 'idle' | 'working' nodes can still act on a nudge. */
  status?: 'idle' | 'working' | 'done' | 'error'
}

/** The minimal Brief Board fact shape the reasoner needs (factId -> sourceNodeId). */
export interface FactRef {
  id: string
  sourceNodeId?: string
}

/** Everything the pure reasoner needs, assembled by the store glue at call time. */
export interface CourseCorrectInput {
  conflicts: Conflict[]
  facts: FactRef[]
  liveNodes: LiveNode[]
}

/** One human-gated course-correction nudge for a single drifting agent. */
export interface CourseCorrection {
  /** stable id: `${targetNodeId}:${subject}:${staleValue}->${teamValue}`. */
  id: string
  /** node id the polite whisper will be enqueued for (a live terminal). */
  targetNodeId: string
  /** the node's live title, for the chip row. */
  targetTitle: string
  /** the consensus subject in dispute (e.g. "auth"). */
  subject: string
  /** the value THIS agent still believes (the minority / stale claim). */
  staleValue: string
  /** the value the rest of the team now believes (the clear team value). */
  teamValue: string
  /** the short Spanish whisper enqueued via relay.enqueueForTarget. */
  note: string
}

/** Cap how many corrections we ever surface, so the chip stays compact. */
export const MAX_CORRECTIONS = 4
/** Cap the whisper note length (terminal-safe, single line). */
const MAX_NOTE = 220

/** A live terminal can still act on a nudge only while idle or working. */
function canStillAct(n: LiveNode | undefined): n is LiveNode {
  return !!n && (n.status === 'idle' || n.status === 'working')
}

/**
 * Compose the polite Spanish course-correction whisper. Single line (no embedded
 * newline — the relay drain submits with a trailing '\r'), capped to MAX_NOTE.
 */
function composeNote(subject: string, teamValue: string, staleValue: string): string {
  const note = t('courseCorrect.note', { subject, teamValue, staleValue })
  return note.length > MAX_NOTE ? note.slice(0, MAX_NOTE - 1) + '…' : note
}

/**
 * Compute the human-gated course corrections. PURE + deterministic.
 *
 * Algorithm (precision-first):
 *   1. Index factId -> sourceNodeId (from the Brief Board facts) and nodeId -> live
 *      node (from the canvas).
 *   2. For each Conflict, resolve each claim to its sourceNodeId via its factId, then
 *      to its live node. Partition into claims whose node is STILL a live terminal
 *      that can act (idle/working) vs. the rest.
 *   3. Emit a correction ONLY when there is EXACTLY ONE such live minority claimant
 *      whose value is distinct from a SINGLE clear team value — defined as one
 *      distinct value held by ALL the OTHER claims in the conflict. If the other
 *      claims disagree among themselves (no single team value), or the live
 *      claimant's value already equals the team value, OMIT (never invent a nudge).
 *   4. De-duplicate by correction id and cap to MAX_CORRECTIONS.
 */
export function computeCourseCorrections(input: CourseCorrectInput): CourseCorrection[] {
  const conflicts = input?.conflicts || []
  if (!conflicts.length) return []

  const sourceByFact = new Map<string, string>()
  for (const f of input.facts || []) {
    if (f && f.id && f.sourceNodeId) sourceByFact.set(f.id, f.sourceNodeId)
  }
  const nodeById = new Map<string, LiveNode>()
  for (const n of input.liveNodes || []) {
    if (n && n.id) nodeById.set(n.id, n)
  }

  const out: CourseCorrection[] = []
  const seen = new Set<string>()

  for (const conflict of conflicts) {
    const claims = conflict?.claims || []
    if (claims.length < 2) continue // need ≥2 distinct agents to disagree

    // Resolve each claim to a live, still-actionable node (if any).
    interface Resolved {
      value: string
      nodeId: string
      node: LiveNode
    }
    const live: Resolved[] = []
    for (const c of claims) {
      const nodeId = c.factId ? sourceByFact.get(c.factId) : undefined
      if (!nodeId) continue
      const node = nodeById.get(nodeId)
      if (!canStillAct(node)) continue
      live.push({ value: c.value, nodeId, node })
    }

    // Exactly ONE still-running claimant can be nudged. More than one live
    // claimant means the disagreement isn't a single clear drift — OMIT.
    if (live.length !== 1) continue
    const minority = live[0]

    // The team value = the single distinct value held by ALL the OTHER claims.
    // If the others disagree among themselves, there is no clear team value -> OMIT.
    const otherValues = new Set(
      claims.filter((c) => c.value !== minority.value).map((c) => c.value)
    )
    if (otherValues.size !== 1) continue
    const teamValue = otherValues.values().next().value as string
    if (!teamValue || teamValue === minority.value) continue

    const id = `${minority.nodeId}:${conflict.subject}:${minority.value}->${teamValue}`
    if (seen.has(id)) continue
    seen.add(id)

    out.push({
      id,
      targetNodeId: minority.nodeId,
      targetTitle: minority.node.title || minority.nodeId,
      subject: conflict.subject,
      staleValue: minority.value,
      teamValue,
      note: composeNote(conflict.subject, teamValue, minority.value)
    })
    if (out.length >= MAX_CORRECTIONS) break
  }

  return out
}
