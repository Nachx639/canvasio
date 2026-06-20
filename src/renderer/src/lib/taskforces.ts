// taskforces.ts
//
// Taskforces — the PURE semantic auto-grouping classifier. It clusters agents by
// the SUBJECT they are independently converging on RIGHT NOW, derived from real
// agent output (recent Echo lines + that agent's Brief Board facts), not from
// geometry, manual selection, or the relay handoff graph.
//
// Today the canvas can group agents two ways: by hand (multi-select / groups /
// regions) or structurally (suggestDistricts/territory.ts cluster by relay
// connectivity + spatial proximity, criticalPath.ts reasons over the relay DAG,
// consensus.ts over pinned-value agreement). NONE of them knows what an agent is
// actually DOING. Two agents far apart on the canvas, with no relay edge between
// them, both deep in the auth flow are invisible as a team — and worse, the
// operator never learns three agents are independently re-deriving the same API
// base (duplicated effort) until it is too late.
//
// This module folds the discoveries agents are ALREADY emitting through the SAME
// deterministic subject vocabulary consensus.ts/insightHarvest.ts use
// (consensus.subjectKey) and groups agents by the subject they share. When ≥2
// agents work the same subject with NO armed relay edge linking them (i.e. they
// are NOT in the same relay component — they are not intentionally collaborating),
// it flags `redundant = true`: "possible duplicated effort".
//
// PURITY CONTRACT (mirrors consensus.ts / criticalPath.ts / territory.ts):
//   - imports ONLY a function (subjectKey) and types; no zustand store, no React,
//     no IPC, no DOM,
//   - never mutates its inputs, fully deterministic, trivially unit-testable,
//   - precision over recall: a node contributes to a subject ONLY when it has
//     ≥ MIN_EVIDENCE matching lines for it; an unsure node is OMITTED. We NEVER
//     invent a subject and we cap the output.
//
// The derived readout is in-memory-only, like every other intelligence surface —
// nothing here is stored or serialized.

import { subjectKey } from './consensus'

/** The minimal per-node evidence the classifier needs: a node id + its recent
 *  meaningful output lines (Echo ring lines + that node's Board fact texts). */
export interface NodeEvidence {
  nodeId: string
  /** recent meaningful lines for this node (Echo + Board fact texts, order-agnostic). */
  lines: string[]
}

/** A single armed relay edge (subset of RelayRule): a pending handoff. Only armed
 *  edges encode a still-live intentional collaboration link. */
export interface TaskforceEdge {
  sourceId: string
  targetId: string
}

/** One taskforce: a subject ≥2 distinct agents are converging on right now. */
export interface Taskforce {
  /** the normalized subject key (consensus vocabulary: "auth", "api base", …). */
  subject: string
  /** the distinct node ids working this subject, sorted for determinism. */
  nodeIds: string[]
  /**
   * true when the members share NO armed relay edge connecting them (they are in
   * different relay components) — "possible duplicated effort". false when they are
   * in the same relay component (intentionally collaborating, not redundant).
   */
  redundant: boolean
}

/** Minimum matching lines a node needs for a subject before it counts as working
 *  it (precision-first: one stray mention does not enlist a node). */
export const MIN_EVIDENCE = 2

/** Hard cap on emitted taskforces (defensive — never flood the chip). */
const MAX_TASKFORCES = 8

/**
 * Group the given node ids into connected components of the ARMED relay graph
 * (undirected: a handoff in either direction links two nodes into the same
 * collaboration). Mirrors territory.relayComponents' union-find idea, but here we
 * keep EVERY node (including singletons) so a membership lookup is total. Pure.
 */
function relayComponentOf(nodeIds: string[], edges: TaskforceEdge[]): Map<string, number> {
  const ids = new Set(nodeIds)
  const parent = new Map<string, string>()
  for (const id of nodeIds) parent.set(id, id)
  const find = (a: string): string => {
    let r = a
    while (parent.get(r) !== r) r = parent.get(r)!
    let c = a
    while (parent.get(c) !== r) {
      const next = parent.get(c)!
      parent.set(c, r)
      c = next
    }
    return r
  }
  const union = (a: string, b: string): void => {
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) parent.set(ra, rb)
  }
  for (const e of edges) {
    if (!ids.has(e.sourceId) || !ids.has(e.targetId)) continue
    if (e.sourceId === e.targetId) continue
    union(e.sourceId, e.targetId)
  }
  // Map each node id to a stable numeric component label (its root's order).
  const rootLabel = new Map<string, number>()
  const out = new Map<string, number>()
  for (const id of nodeIds) {
    const root = find(id)
    if (!rootLabel.has(root)) rootLabel.set(root, rootLabel.size)
    out.set(id, rootLabel.get(root)!)
  }
  return out
}

/**
 * Derive each node's set of subjects it is WORKING — a subject for which it has
 * ≥ MIN_EVIDENCE matching evidence lines (via consensus.subjectKey). A node may
 * legitimately work more than one subject (e.g. auth + endpoint); each is counted
 * independently. Lines whose subject is ambiguous (subjectKey -> null) are ignored.
 * Pure + deterministic.
 */
function subjectsOf(ev: NodeEvidence): Set<string> {
  const counts = new Map<string, number>()
  for (const line of ev.lines) {
    const key = subjectKey(line)
    if (!key) continue
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  const out = new Set<string>()
  for (const [key, n] of counts) if (n >= MIN_EVIDENCE) out.add(key)
  return out
}

/**
 * Compute the live taskforces. PURE + deterministic.
 *
 * Algorithm (precision-first):
 *   1. For each node, derive the subjects it is working (≥ MIN_EVIDENCE matching
 *      lines). A node unsure about every subject contributes nothing.
 *   2. Invert to subject -> distinct node ids. Keep ONLY subjects with ≥2 agents
 *      (a single agent on a subject is not a taskforce).
 *   3. Flag redundant = true when the members span >1 armed-relay component (no
 *      relay edge ties them together: they may be duplicating effort). When all
 *      members live in ONE relay component they are intentionally collaborating ->
 *      not redundant.
 *   4. Deterministic ordering: redundant taskforces first (the actionable ones),
 *      then by subject, then by member count; node ids sorted within each. Capped.
 */
export function computeTaskforces(
  evidence: NodeEvidence[],
  edges: TaskforceEdge[]
): Taskforce[] {
  if (!evidence || evidence.length === 0) return []

  // (1)+(2) subject -> distinct node ids working it
  const bySubject = new Map<string, Set<string>>()
  for (const ev of evidence) {
    if (!ev || !ev.nodeId) continue
    for (const subject of subjectsOf(ev)) {
      const set = bySubject.get(subject) ?? new Set<string>()
      set.add(ev.nodeId)
      bySubject.set(subject, set)
    }
  }

  const out: Taskforce[] = []
  for (const [subject, idSet] of bySubject) {
    if (idSet.size < 2) continue // need ≥2 agents to form a taskforce
    const nodeIds = [...idSet].sort()
    // (3) redundant when the members span more than one armed-relay component.
    const comp = relayComponentOf(nodeIds, edges)
    const labels = new Set(nodeIds.map((id) => comp.get(id)))
    const redundant = labels.size > 1
    out.push({ subject, nodeIds, redundant })
  }

  // (4) deterministic ordering, redundant (actionable) first.
  out.sort((a, b) => {
    if (a.redundant !== b.redundant) return a.redundant ? -1 : 1
    if (a.subject !== b.subject) return a.subject < b.subject ? -1 : 1
    return b.nodeIds.length - a.nodeIds.length
  })
  return out.slice(0, MAX_TASKFORCES)
}
