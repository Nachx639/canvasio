// flightplan.ts (store glue)
//
// Flightplan — store glue for the pre-flight conflict classifier
// (lib/flightplan.ts). A TINY zustand store that holds NOTHING persistent
// (IN-MEMORY ONLY, never added to canvas.ts loadLayout / serialization — the same
// contract as taskforces.ts / conductor.ts). It is STATELESS: it caches nothing,
// so there is nothing for resetRelayAndMission to clear.
//
// It exists only to:
//   1) getFlightplan(taskText, selfNodeId?) — lazily read useCanvas (live nodes),
//      useChangeset (dirty files per node), and useBoard (subjects per node) at
//      CALL TIME ONLY (never at module init), assemble the Incumbent[] inputs, and
//      return predictConflicts(extractTargets(taskText), incumbents, selfNodeId).
//   2) stageBehind(newNodeId, incumbentNodeId) — auto-wire a relay handoff so the
//      NEW agent waits for the incumbent, routing ONLY through the EXISTING
//      useRelay.addRule (the same "stage behind" wiring runRecipe uses). Zero
//      geometry mutation, zero IPC.
//
// CALL-TIME-ONLY DISCIPLINE: like taskforces.getTaskforces() and
// conductor.getRecommendations(), every cross-store read happens INSIDE the
// method, never at module init, so the ES-module import graph has no
// initialization-order hazard.

import { create } from 'zustand'
import { useCanvas, type CanvasNode, AGENT_LABEL } from './canvas'
import { useChangeset } from './changeset'
import { useBoard } from './board'
import { useRelay } from './relay'
import { subjectKey } from '../lib/consensus'
import { t } from './i18n'
import {
  extractTargets,
  predictConflicts,
  type FlightConflict,
  type Incumbent
} from '../lib/flightplan'

/** Human label for a node: its title, falling back to the agent persona. */
function labelOf(n: CanvasNode): string {
  return n.title || (n.agent ? AGENT_LABEL[n.agent].title : t('flightplan.agent_fallback'))
}

/**
 * Module-level stable-reference guard, mirroring taskforces.lastTaskforces and
 * relay.lastCritical. getFlightplan() rebuilds a fresh array on every call, but
 * its sole subscriber (FlightplanChip, which re-runs on every changeset poll /
 * board / node change) relies on a useMemo that re-fires whenever the returned
 * reference changes. When the prediction is structurally unchanged we return the
 * SAME array reference so the chip's memo short-circuits. Pure caching of a
 * reference only — the data is identical, so behavior is preserved. Keyed by the
 * task text so a different new node's prediction never aliases a stale cache.
 */
let lastKey = ''
let lastConflicts: FlightConflict[] = []

/** Structural equality for the flightplan result (order-sensitive; predictConflicts
 *  sorts + caps deterministically, so identical inputs yield identical order). */
function sameConflicts(prev: FlightConflict[], next: FlightConflict[]): boolean {
  if (prev.length !== next.length) return false
  for (let i = 0; i < next.length; i++) {
    const a = prev[i]
    const b = next[i]
    if (a.nodeId !== b.nodeId || a.kind !== b.kind || a.detail !== b.detail) return false
  }
  return true
}

interface FlightplanState {
  /**
   * Lazily assemble the Incumbent[] from every existing in-memory surface and
   * return the predicted conflicts for `taskText`. Reads all stores via getState()
   * INSIDE the call only, keeping flightplan.ts's call-time-only import discipline.
   * Pure downstream: predictConflicts never mutates anything. Defensive — any
   * unavailable store degrades to its empty form. `selfNodeId` (the new node) is
   * excluded so we never flag it against itself.
   */
  getFlightplan: (taskText: string, selfNodeId?: string) => FlightConflict[]
  /**
   * Auto-wire a "stage behind" relay handoff: the NEW node waits for the incumbent
   * to finish, then is nudged to proceed. Routes ONLY through the EXISTING
   * useRelay.addRule (source = incumbent, target = new node), the same mechanism
   * runRecipe uses. Zero geometry mutation, zero IPC. Returns true when armed.
   */
  stageBehind: (newNodeId: string, incumbentNodeId: string) => boolean
}

export const useFlightplan = create<FlightplanState>(() => ({
  getFlightplan: (taskText, selfNodeId) => {
    const key = `${selfNodeId ?? ''}::${(taskText || '').trim()}`

    // --- read every surface lazily (call-time only) ---
    let nodes: CanvasNode[] = []
    try {
      nodes = useCanvas.getState().nodes
    } catch {
      /* no canvas */
    }
    const byNode = (() => {
      try {
        return useChangeset.getState().byNode
      } catch {
        return {} as Record<string, { files: { path: string }[] }>
      }
    })()
    const boardFacts = (() => {
      try {
        return useBoard.getState().facts
      } catch {
        return [] as { text: string; sourceNodeId?: string }[]
      }
    })()

    // Per-node Brief Board subjects (fold each fact through the SHARED subjectKey
    // vocabulary every other surface uses), grouped by the fact's source node.
    const subjectsByNode = new Map<string, Set<string>>()
    for (const f of boardFacts) {
      if (!f.sourceNodeId || !f.text) continue
      const key2 = subjectKey(f.text)
      if (!key2) continue
      const set = subjectsByNode.get(f.sourceNodeId) ?? new Set<string>()
      set.add(key2)
      subjectsByNode.set(f.sourceNodeId, set)
    }

    // Incumbents = LIVE terminal agents OTHER than the new node, each carrying its
    // actual dirty-file set + its Board subjects. A terminal with neither still
    // appears (predictConflicts simply won't match it), keeping the lib decision.
    const incumbents: Incumbent[] = nodes
      .filter((n) => n.kind === 'terminal' && n.id !== selfNodeId)
      .map((n) => {
        const cs = byNode[n.id] as { files?: { path: string }[] } | undefined
        const dirtyPaths = (cs?.files ?? []).map((file) => file.path)
        const subjects = [...(subjectsByNode.get(n.id) ?? new Set<string>())]
        return { nodeId: n.id, title: labelOf(n), dirtyPaths, subjects }
      })

    const next = predictConflicts(extractTargets(taskText), incumbents, selfNodeId)
    if (key === lastKey && sameConflicts(lastConflicts, next)) return lastConflicts
    lastKey = key
    lastConflicts = next
    return next
  },

  stageBehind: (newNodeId, incumbentNodeId) => {
    if (!newNodeId || !incumbentNodeId || newNodeId === incumbentNodeId) return false
    try {
      const id = useRelay.getState().addRule({
        sourceId: incumbentNodeId,
        targetId: newNodeId,
        // A terminal-safe one-liner: when the incumbent finishes, the new agent is
        // released to proceed (delivered via the same readiness-gated relay drain).
        text: 'El agente anterior terminó su trabajo en esta zona. Continúa con tu tarea ahora.',
        once: true
      })
      return id != null
    } catch {
      return false
    }
  }
}))
