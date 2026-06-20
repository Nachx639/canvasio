// sentinel.ts (store)
//
// Sentinel — spatial standing orders ("watch X for Y, then fly me there"). The
// in-memory store that owns the armed orders[] (the only Sentinel state). The
// PURE decision of WHICH orders fire lives in lib/sentinel.ts; this store owns
// the lifecycle: arm / disarm / toggle-auto-fly / clear, the per-order
// arm-time baseline (so a condition already true at arm-time doesn't instantly
// fire), marking an order fired, and pruning orders for removed nodes.
//
// IMPORTANT — persistence contract: this state lives ONLY in memory, exactly
// like mission.ts / lens.ts / relay.ts. It is NEVER added to canvas.ts
// loadLayout / App.tsx serialization (no canvasio:layout key) and NEVER crosses IPC.
// A fresh / restored canvas always starts with no armed orders. The reset() is
// registered through canvas.ts's one-directional registerSentinelReset hook so
// resetRelayAndMission wipes orders alongside the rest of the memory-only stores.
//
// Import discipline: this store imports canvas.ts (for the reset registry, the
// live node ids, and the centerOnNode fire path) + mission.ts/lens.ts (for the
// arm-time baseline), but ONLY ever touches them at CALL TIME (getState()),
// never at module init — the same deferred-usage rule stall.ts / backlog.ts
// follow, so the ES-module cycle through canvas.ts resolves cleanly.

import { create } from 'zustand'
import { nanoid } from 'nanoid'
import { useCanvas, registerSentinelReset } from './canvas'
import { useMission, latestEventByNode } from './mission'
import { useLens } from './lens'
import { evaluateOrders, type SentinelKind, type SentinelOrder } from '../lib/sentinel'

export type { SentinelKind, SentinelOrder } from '../lib/sentinel'

/**
 * Compute the arm-time baseline for a new order on `nodeId`: the most recent ts
 * among the substrates the order will be evaluated against (its latest mission
 * event ts and its current Lens line ts), or Date.now() when the node has no
 * activity yet. Only facts STRICTLY newer than this baseline can fire the order,
 * so a status already in effect / a line already on screen at arm-time never
 * trips it — you only get woken by something that happens AFTER you walk away.
 * Call-time reads only (mission/lens), never at module init.
 */
function armBaseline(nodeId: string): number {
  let baseline = Date.now()
  const latest = latestEventByNode(useMission.getState().events).get(nodeId)
  if (latest && latest.ts > baseline) baseline = latest.ts
  const line = useLens.getState().lines[nodeId]
  if (line && line.ts > baseline) baseline = line.ts
  return baseline
}

interface SentinelState {
  /** every armed standing order (memory-only; never persisted, never IPC). */
  orders: SentinelOrder[]
  /**
   * Arm a standing order on a node. Captures the arm-time baseline so an
   * already-true condition doesn't instantly fire. For kind==='match', `pattern`
   * is the user's regex source (compiled safely at eval time; a bad pattern
   * simply never fires). Returns the new order id.
   */
  arm: (nodeId: string, kind: SentinelKind, pattern?: string) => string
  /** Disarm (remove) a single order by id. */
  disarm: (id: string) => void
  /**
   * Disarm every order on a node (the node-header toggle's "off" path), or, if a
   * kind is given, only that node+kind. Returns how many were removed.
   */
  disarmNode: (nodeId: string, kind?: SentinelKind) => number
  /** Flip an order's auto-fly (fire => fly the camera there, vs. just pulse). */
  toggleAutoFly: (id: string) => void
  /** Mark an order as fired now (so it goes quiet until re-armed). */
  markFired: (id: string) => void
  /**
   * Re-arm a fired order: clear its firedTs and re-baseline against the current
   * substrates (so the just-fired condition doesn't immediately re-fire).
   */
  rearm: (id: string) => void
  /** Drop every order whose node id is not in the given live set (prune). */
  pruneFor: (liveNodeIds: ReadonlySet<string>) => void
  /** Wipe all armed orders (new_canvas / loadLayout via the reset hook). */
  reset: () => void
  /**
   * Run the PURE evaluator over the live substrates and return the ids of orders
   * whose condition NEWLY holds (still-armed + true now + node still alive). The
   * App ticker calls this on every mission/lens change, then markFired + (if
   * autoFly) centerOnNode each returned id. Call-time substrate reads only.
   */
  evaluate: () => string[]
}

/** Live node ids on the canvas right now (call-time read). */
function liveNodeIds(): Set<string> {
  return new Set(useCanvas.getState().nodes.map((n) => n.id))
}

export const useSentinel = create<SentinelState>((set, get) => ({
  orders: [],

  arm: (nodeId, kind, pattern) => {
    const id = nanoid(8)
    const order: SentinelOrder = {
      id,
      nodeId,
      kind,
      pattern: kind === 'match' ? (pattern ?? '') : undefined,
      baselineTs: armBaseline(nodeId),
      firedTs: null,
      autoFly: true
    }
    set((s) => ({ orders: [...s.orders, order] }))
    return id
  },

  disarm: (id) => set((s) => ({ orders: s.orders.filter((o) => o.id !== id) })),

  disarmNode: (nodeId, kind) => {
    let removed = 0
    set((s) => {
      const next = s.orders.filter((o) => {
        const hit = o.nodeId === nodeId && (kind == null || o.kind === kind)
        if (hit) removed++
        return !hit
      })
      return removed > 0 ? { orders: next } : {}
    })
    return removed
  },

  toggleAutoFly: (id) =>
    set((s) => ({
      orders: s.orders.map((o) => (o.id === id ? { ...o, autoFly: !o.autoFly } : o))
    })),

  markFired: (id) =>
    set((s) => ({
      orders: s.orders.map((o) =>
        o.id === id && o.firedTs === null ? { ...o, firedTs: Date.now() } : o
      )
    })),

  rearm: (id) =>
    set((s) => ({
      orders: s.orders.map((o) =>
        o.id === id ? { ...o, firedTs: null, baselineTs: armBaseline(o.nodeId) } : o
      )
    })),

  pruneFor: (live) =>
    set((s) => {
      const next = s.orders.filter((o) => live.has(o.nodeId))
      return next.length === s.orders.length ? {} : { orders: next }
    }),

  reset: () => set({ orders: [] }),

  evaluate: () => {
    const { orders } = get()
    if (orders.length === 0) return []
    const live = liveNodeIds()
    const latest = latestEventByNode(useMission.getState().events)
    const lens = useLens.getState().lines
    return evaluateOrders(orders, latest, lens, live)
  }
}))

// Register the full-reset hook so new_canvas / loadLayout / bootRecipe wipe all
// armed orders alongside resetRelayAndMission. Reached lazily through canvas.ts's
// registry to keep the one-directional-import contract (sentinel.ts imports
// canvas.ts, never the reverse).
registerSentinelReset(() => {
  useSentinel.getState().reset()
})
