// backlog.ts
//
// Backlog — the per-agent "unseen activity" attention router (PURE math layer).
//
// When you supervise several agents on an infinite canvas, the question nothing
// answers is: "which agent did something worth seeing while my back was turned?"
// Every existing surface shows current STATE (status dots, Pulse Radar, Thermal,
// Director), searchable HISTORY (Echo, Recall, Command Trail), or a TIMELINE you
// have to open (Chronoscope, Replay). None tracks what YOU personally have not
// yet seen, per agent.
//
// CanvasIO already records two in-memory facts:
//   - canvas.visits[id].lastTs — "when I last LOOKED at this agent" (bumped at the
//     single centerOnNode chokepoint every manual jump funnels through).
//   - echo.entries[id] — a per-node ring of meaningful output lines, each stamped
//     with ts.
// Backlog joins them: unseen(id) = count of this agent's Echo lines with
// ts > visits[id].lastTs (a never-visited node has lastTs absent => 0, so ALL its
// lines count as unseen). Flying to a node bumps lastTs, so the count zeroes the
// instant you actually look.
//
// This module is the PURE, side-effect-free synthesis layer mirroring
// chronoscope.ts / missionBrief.ts discipline:
//   - imports ONLY types (no zustand stores, no React, no IPC, no main process),
//   - never mutates its inputs,
//   - is fully deterministic given the same inputs (unit-testable; `sinceTs` is an
//     explicit argument, never Date.now()).

import type { EchoLine } from '../store/echo'

/** A node's resolved unseen-activity tally, used to pick the peak. */
export interface UnseenTally {
  nodeId: string
  /** how many of this node's Echo lines are newer than its lastTs watermark. */
  count: number
  /** ts of this node's most-recent Echo line (0 when it has none). Tie-breaker. */
  newestTs: number
}

/**
 * Count how many of a node's captured Echo lines are NEWER than the watermark
 * (the ts of the last time the operator looked at this node). A line is "unseen"
 * iff its ts is strictly greater than sinceTs.
 *
 * Number-safe: a missing/NaN sinceTs is treated as 0 (never visited) so every
 * line counts. Pure — `ring` is never mutated.
 */
export function countUnseen(ring: EchoLine[] | undefined, sinceTs: number): number {
  if (!ring || ring.length === 0) return 0
  const since = Number.isFinite(sinceTs) ? sinceTs : 0
  let n = 0
  for (const line of ring) {
    if (line.ts > since) n++
  }
  return n
}

/** ts of the most-recent line in a ring (0 when empty/absent). Pure. */
export function newestTs(ring: EchoLine[] | undefined): number {
  if (!ring || ring.length === 0) return 0
  let max = 0
  for (const line of ring) {
    if (line.ts > max) max = line.ts
  }
  return max
}

/**
 * The agent (= node id) with the most unseen activity, or null when nobody has
 * any. Read-only over the three existing facts:
 *   - nodeIds: the live terminal node ids to consider (caller filters to
 *     kind==='terminal' so music/web nodes never appear),
 *   - visits: canvas.visits (nodeId -> { lastTs }); a node absent here was never
 *     visited (watermark 0 => all its lines unseen),
 *   - echoEntries: echo.entries (nodeId -> ring of stamped lines).
 *
 * Tie-break: when two nodes have the same unseen count, the one whose newest line
 * is more recent wins (you most likely want the freshest activity first).
 */
export function pickPeak(
  nodeIds: string[],
  visits: Record<string, { lastTs: number }>,
  echoEntries: Record<string, EchoLine[]>
): string | null {
  let best: UnseenTally | null = null
  for (const id of nodeIds) {
    const ring = echoEntries[id]
    const count = countUnseen(ring, visits[id]?.lastTs ?? 0)
    if (count === 0) continue
    const newest = newestTs(ring)
    if (
      best === null ||
      count > best.count ||
      (count === best.count && newest > best.newestTs)
    ) {
      best = { nodeId: id, count, newestTs: newest }
    }
  }
  return best ? best.nodeId : null
}

/**
 * Total unseen lines across all given nodes (the TopBar attention chip's number).
 * Read-only over the same two facts; pure.
 */
export function totalUnseen(
  nodeIds: string[],
  visits: Record<string, { lastTs: number }>,
  echoEntries: Record<string, EchoLine[]>
): number {
  let total = 0
  for (const id of nodeIds) {
    total += countUnseen(echoEntries[id], visits[id]?.lastTs ?? 0)
  }
  return total
}

/**
 * Count how many of the given agents (= node ids) have ANY unseen activity
 * (at least one Echo line newer than their watermark). This is the intuitive
 * swarm-level number for the TopBar chip — "how many agents owe me a look" —
 * rather than the raw line total. Read-only over the same two facts; pure.
 */
export function agentsWithUnseen(
  nodeIds: string[],
  visits: Record<string, { lastTs: number }>,
  echoEntries: Record<string, EchoLine[]>
): number {
  let n = 0
  for (const id of nodeIds) {
    if (countUnseen(echoEntries[id], visits[id]?.lastTs ?? 0) > 0) n++
  }
  return n
}
