// taskforces.ts (store glue)
//
// Taskforces — store glue for the semantic auto-grouping classifier
// (lib/taskforces.ts). A TINY zustand store that holds NOTHING persistent
// (IN-MEMORY ONLY, never added to canvas.ts loadLayout / serialization — the same
// contract as conductor.ts / horizon.ts). It is STATELESS: it caches nothing, so
// there is nothing for resetRelayAndMission to clear.
//
// It exists only to:
//   1) getTaskforces() — lazily read useCanvas / useEcho / useBoard / useRelay at
//      CALL TIME ONLY (never at module init), assemble the pure NodeEvidence +
//      armed-edge inputs, and return computeTaskforces(...). The per-node evidence
//      is each terminal's recent Echo ring lines PLUS that node's Brief Board fact
//      texts — exactly the "discoveries agents are already emitting" the feature
//      folds through consensus.subjectKey.
//   2) frameTaskforce(nodeIds) — fly the camera to the bounding box of the given
//      members, routing ONLY through the existing useCanvas camera framing
//      (centerOnBounds, the same tween Districts use; centerOnNode for a single
//      member). Zero geometry mutation, zero IPC, never serialized.
//
// CALL-TIME-ONLY DISCIPLINE: like conductor.getRecommendations() and
// relay.criticalPath(), every cross-store read happens INSIDE the method, never at
// module init, so the ES-module import graph has no initialization-order hazard.

import { create } from 'zustand'
import { useCanvas, type CanvasNode } from './canvas'
import { useEcho } from './echo'
import { useBoard } from './board'
import { useRelay } from './relay'
import {
  computeTaskforces,
  type Taskforce,
  type NodeEvidence,
  type TaskforceEdge
} from '../lib/taskforces'

/** How many recent Echo lines per node to fold into the evidence (cheap cap; the
 *  ring is already ~60). We take the tail so we reason about RECENT work. */
const ECHO_TAIL = 24

/**
 * Module-level stable-reference guard, mirroring useRelay.criticalPath()
 * (relay.ts) and useChangeset.collisions() (changeset.ts). getTaskforces() rebuilds
 * a fresh array on every call, but its sole subscriber (TaskforcesChip, which
 * subscribes to useEcho.entries and thus re-runs on every streamed terminal line)
 * relies on a useMemo that re-fires whenever the returned reference changes. When
 * the grouping is structurally unchanged we return the SAME array reference so the
 * chip's memo short-circuits instead of re-rendering on every output line. Pure
 * caching of a reference only — the data is identical, so behavior is preserved.
 */
let lastTaskforces: Taskforce[] = []

/** Structural equality for the taskforces result: same length, and each entry's
 *  subject + redundant + nodeIds (order-sensitive; the producer sorts nodeIds and
 *  caps deterministically, so identical inputs yield identical order). */
function sameTaskforces(prev: Taskforce[], next: Taskforce[]): boolean {
  if (prev.length !== next.length) return false
  for (let i = 0; i < next.length; i++) {
    const a = prev[i]
    const b = next[i]
    if (a.subject !== b.subject || a.redundant !== b.redundant) return false
    if (a.nodeIds.length !== b.nodeIds.length) return false
    for (let j = 0; j < b.nodeIds.length; j++) {
      if (a.nodeIds[j] !== b.nodeIds[j]) return false
    }
  }
  return true
}

interface TaskforcesState {
  /**
   * Lazily assemble the pure inputs from every existing in-memory surface and
   * return the live taskforces. Reads all stores via getState() INSIDE the call
   * only, keeping taskforces.ts's call-time-only import discipline. Pure
   * downstream: computeTaskforces never mutates anything. Defensive — any
   * unavailable store degrades to its empty form.
   */
  getTaskforces: () => Taskforce[]
  /**
   * Fly the camera to frame the given taskforce members, via EXISTING camera
   * actions only (centerOnBounds for ≥2, centerOnNode for 1). No new IPC, no
   * geometry mutation beyond the existing camera tween. Returns true when it flew.
   */
  frameTaskforce: (nodeIds: string[]) => boolean
}

export const useTaskforces = create<TaskforcesState>(() => ({
  getTaskforces: () => {
    // --- read every surface lazily (call-time only) ---
    let nodes: CanvasNode[] = []
    try {
      nodes = useCanvas.getState().nodes
    } catch {
      /* no canvas */
    }
    const echo = (() => {
      try {
        return useEcho.getState().entries
      } catch {
        return {} as Record<string, { text: string }[]>
      }
    })()
    const boardFacts = (() => {
      try {
        return useBoard.getState().facts
      } catch {
        return [] as { text: string; sourceNodeId?: string }[]
      }
    })()
    const rules = (() => {
      try {
        return useRelay.getState().rules
      } catch {
        return [] as { sourceId: string; targetId: string }[]
      }
    })()

    // Per-node Board fact texts, grouped by their source node (provenance).
    const factsByNode = new Map<string, string[]>()
    for (const f of boardFacts) {
      if (!f.sourceNodeId || !f.text) continue
      const a = factsByNode.get(f.sourceNodeId)
      if (a) a.push(f.text)
      else factsByNode.set(f.sourceNodeId, [f.text])
    }

    // Evidence = recent Echo lines + that node's Board facts, for each terminal.
    const terminals = nodes.filter((n) => n.kind === 'terminal')
    const evidence: NodeEvidence[] = terminals.map((n) => {
      const echoLines = (echo[n.id] ?? []).slice(-ECHO_TAIL).map((l) => l.text)
      const facts = factsByNode.get(n.id) ?? []
      return { nodeId: n.id, lines: [...echoLines, ...facts] }
    })

    // Armed edges only (a still-live intentional collaboration link), restricted
    // to existing terminals — matching criticalPath()'s armed-edges semantics.
    const known = new Set(terminals.map((n) => n.id))
    const edges: TaskforceEdge[] = rules
      .filter(
        (r: { armed?: boolean; sourceId: string; targetId: string }) =>
          r.armed !== false && known.has(r.sourceId) && known.has(r.targetId)
      )
      .map((r) => ({ sourceId: r.sourceId, targetId: r.targetId }))

    const next = computeTaskforces(evidence, edges)
    if (sameTaskforces(lastTaskforces, next)) return lastTaskforces
    lastTaskforces = next
    return next
  },

  frameTaskforce: (nodeIds) => {
    if (!nodeIds || nodeIds.length === 0) return false
    try {
      const all = useCanvas.getState().nodes
      const members = all.filter((n) => nodeIds.includes(n.id))
      if (members.length === 0) return false
      if (members.length === 1) {
        useCanvas.getState().centerOnNode(members[0].id)
        return true
      }
      // Bounding box of the members -> the same camera tween Districts fly with.
      let minX = Infinity
      let minY = Infinity
      let maxX = -Infinity
      let maxY = -Infinity
      for (const n of members) {
        minX = Math.min(minX, n.x)
        minY = Math.min(minY, n.y)
        maxX = Math.max(maxX, n.x + n.w)
        maxY = Math.max(maxY, n.y + n.h)
      }
      useCanvas.getState().centerOnBounds({ x: minX, y: minY, w: maxX - minX, h: maxY - minY })
      return true
    } catch {
      return false
    }
  }
}))
