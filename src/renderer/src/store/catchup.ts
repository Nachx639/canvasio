// catchup.ts (store)
//
// Catch-Up — store glue for the per-agent "what happened since you last looked"
// unread digest. A tiny MEMORY-ONLY zustand store holding just an `enabled`
// settings flag (default on) plus a per-node `dismissedAt` override map so the
// operator can explicitly "mark caught-up" WITHOUT a camera jump.
//
// The real work lives in the PURE lib/catchup.ts kernel. The selectors here read
// the LIVE substrates lazily (call-time only, never at module-init) — Mission
// Pulse, Echo, Command Trail, Changeset — plus the existing canvas read-marker
// `visits[id].lastTs`, and call buildCatchup. The read-marker is ALREADY bumped
// at the single centerOnNode chokepoint on every manual jump / selection, so
// jumping to (or selecting) a node clears its unread for free with ZERO change to
// canvas.ts. dismissedAt is an additional, higher watermark for the explicit
// "mark all caught-up" action.
//
// IMPORTANT — persistence contract: this state lives ONLY in memory, exactly like
// lens.ts / mission.ts / changeset.ts. It is NEVER added to canvas.ts loadLayout /
// App.tsx serialization, NEVER sent over IPC, and is registered into the
// resetRelayAndMission() clear set (via the reset hook) so a fresh / loaded canvas
// always starts caught-up. Imports only types from the substrate stores (read
// lazily at call-time) so there is no module-init cycle.

import { create } from 'zustand'
import { useMission } from './mission'
import { useEcho } from './echo'
import { useCommandTrail } from './commandTrail'
import { useChangeset } from './changeset'
import { useCanvas, registerCatchupReset } from './canvas'
import { buildCatchup, type CatchupDelta } from '../lib/catchup'

/** Shared empty result so the no-unread case keeps a stable reference. */
const EMPTY_DELTAS: CatchupDelta[] = []

interface CatchupState {
  /** master feature flag (pip + panel). Default ON; memory-only. */
  enabled: boolean
  setEnabled: (on: boolean) => void
  /**
   * Explicit "marked caught-up" watermark per node (ms). Higher than the natural
   * visits.lastTs read-marker; lets `m` in the panel zero an agent's unread
   * WITHOUT moving the camera. Memory-only, never persisted.
   */
  dismissedAt: Record<string, number>
  /** Bump a single node's dismissed watermark to `ts` (default now). */
  dismiss: (nodeId: string, ts?: number) => void
  /** Bump every given node's dismissed watermark to `ts` (the panel's `m`). */
  dismissAll: (nodeIds: string[], ts?: number) => void
  /** Drop a node's dismissed entry (call on node disposal / full reset). */
  clearForNode: (nodeId: string) => void
  /** Wipe all dismissed watermarks (call on new_canvas / clear). */
  clearAll: () => void
  /**
   * The unread delta for ONE node, joining its read-marker (max of visits.lastTs
   * and dismissedAt) against the four live substrates via buildCatchup. Reads the
   * stores lazily INSIDE the call only (call-time-only discipline, like
   * mission.getBrief / changeset.collisions) so this store keeps a clean import
   * graph. Pure read; never mutates anything.
   */
  deltaFor: (nodeId: string) => CatchupDelta
  /**
   * Every TERMINAL node with unread activity, newest-delta-first. Read-only over
   * the live canvas nodes + the same substrates. Returns a STABLE empty reference
   * when nobody has unread so subscribers don't churn.
   */
  allUnread: () => CatchupDelta[]
}

/** The effective read-marker for a node: the later of "last looked at" (visits)
 *  and "explicitly marked caught-up" (dismissedAt). A node never looked at AND
 *  never dismissed yields 0 => everything captured is unread. */
function markerFor(
  nodeId: string,
  visits: Record<string, { lastTs: number } | undefined>,
  dismissedAt: Record<string, number>
): number {
  const looked = visits[nodeId]?.lastTs ?? 0
  const dismissed = dismissedAt[nodeId] ?? 0
  return Math.max(looked, dismissed)
}

/** The feature flag is a USER PREFERENCE (not canvas state), so it persists under
 *  its own localStorage key — exactly like the other observability toggles
 *  (cmdtrail / backlog / recall). Default ON: only an explicit 'off' disables it.
 *  This is a preference, NOT canvas/layout state, so it is never part of the
 *  canvasio:layout serialization or IPC — the persistence contract above still holds. */
const ENABLED_KEY = 'canvasio:catchup'
function loadEnabled(): boolean {
  try {
    return localStorage.getItem(ENABLED_KEY) !== 'off'
  } catch {
    return true
  }
}

export const useCatchup = create<CatchupState>((set, get) => ({
  enabled: loadEnabled(),
  setEnabled: (on) => {
    try {
      localStorage.setItem(ENABLED_KEY, on ? 'on' : 'off')
    } catch {
      /* ignore quota/blocked storage */
    }
    set({ enabled: on })
  },

  dismissedAt: {},

  dismiss: (nodeId, ts) =>
    set((s) => ({ dismissedAt: { ...s.dismissedAt, [nodeId]: ts ?? Date.now() } })),

  dismissAll: (nodeIds, ts) =>
    set((s) => {
      if (nodeIds.length === 0) return {}
      const at = ts ?? Date.now()
      const next = { ...s.dismissedAt }
      for (const id of nodeIds) next[id] = at
      return { dismissedAt: next }
    }),

  clearForNode: (nodeId) =>
    set((s) => {
      if (!(nodeId in s.dismissedAt)) return {}
      const { [nodeId]: _drop, ...rest } = s.dismissedAt
      return { dismissedAt: rest }
    }),

  clearAll: () => set({ dismissedAt: {} }),

  deltaFor: (nodeId) => {
    const since = markerFor(nodeId, useCanvas.getState().visits, get().dismissedAt)
    return buildCatchup(nodeId, since, {
      events: useMission.getState().events,
      echoLines: useEcho.getState().entries[nodeId],
      trailEntries: useCommandTrail.getState().entries[nodeId],
      changeset: useChangeset.getState().byNode[nodeId]
    })
  },

  allUnread: () => {
    let nodes: { id: string; kind: string }[] = []
    try {
      nodes = useCanvas.getState().nodes
    } catch {
      return EMPTY_DELTAS
    }
    const visits = useCanvas.getState().visits
    const { dismissedAt } = get()
    const events = useMission.getState().events
    const echo = useEcho.getState().entries
    const trail = useCommandTrail.getState().entries
    const changeset = useChangeset.getState().byNode

    const out: CatchupDelta[] = []
    for (const n of nodes) {
      if (n.kind !== 'terminal') continue
      const since = markerFor(n.id, visits, dismissedAt)
      const delta = buildCatchup(n.id, since, {
        events,
        echoLines: echo[n.id],
        trailEntries: trail[n.id],
        changeset: changeset[n.id]
      })
      if (delta.unreadCount > 0) out.push(delta)
    }
    if (out.length === 0) return EMPTY_DELTAS
    // Newest-delta-first (the agent that just moved floats to the top).
    out.sort((a, b) => b.newestTs - a.newestTs)
    return out
  }
}))

// Register the memory-only reset into the canvas-wide clear set. canvas.ts can't
// import this module (it would invert the import graph), so it exposes a
// registration hook that resetRelayAndMission() invokes if present — exactly the
// pattern stall.ts / tripwire.ts / contextSync.ts use. Wiping dismissedAt on a
// full reset guarantees a fresh / loaded canvas starts caught-up.
registerCatchupReset(() => {
  useCatchup.getState().clearAll()
})
