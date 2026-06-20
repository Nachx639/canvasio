// contextSync.ts (store)
//
// Context Sync — the in-memory consumption ledger + supersession driver behind
// the Fact Invalidation Bus. When the Brief Board injects facts into a node, this
// store remembers WHICH (subject,value) that node received. Later, when the
// Board's newest value for one of those subjects changes (a newer fact, a
// Consensus correction, or a human edit), detectStale() surfaces the exact
// (node, subject) pairs that are now working on an outdated value, and
// pushCorrection() delivers a one-line Spanish nudge to that node — riding the
// SAME readiness-gated relay drain (enqueueForTarget -> deliverRelay ->
// window.canvasio.pty.write) that handoffs and Board injection already use. No new
// delivery path, no IPC.
//
// PERSISTENCE / CYCLE CONTRACT (mirrors board.ts / relay.ts / taskforces.ts):
//   - state lives ONLY in memory, NEVER serialized into canvas.ts loadLayout and
//     NEVER sent over IPC, so it cannot affect persistence or cold-start,
//   - imports NOTHING from canvas.ts (no cycle); the live Board facts + the relay
//     drain are read lazily via getState() at CALL TIME only, exactly like
//     conductor.ts / taskforces.ts,
//   - cleared by resetRelayAndMission() (registered via a hook, since canvas.ts
//     cannot import this back) so New Canvas / load wipes the ledger.

import { create } from 'zustand'
import { useBoard, type BoardFact } from './board'
import { useRelay } from './relay'
import { registerContextSyncReset } from './canvas'
import {
  computeStale,
  consumedFromFact,
  formatCorrection,
  hitKey,
  type ConsumedFact,
  type Ledger,
  type StaleHit
} from '../lib/contextSync'

/** Bound the per-node consumption ring so the ledger can never grow unbounded. */
const MAX_PER_NODE = 32

interface ContextSyncState {
  /**
   * The consumption ledger: node id -> the (subject,value,ts) facts that node has
   * received via Board injection. A plain object (not a Map) so zustand sees a new
   * reference on update; computeStale takes a Map so detectStale() adapts it.
   */
  ledger: Record<string, ConsumedFact[]>
  /**
   * Hits already pushed (by hitKey) so a confirmed/auto correction never re-fires
   * for the same (node, subject, newValue). In-memory only.
   */
  pushed: Record<string, true>
  /** Hits the operator dismissed (by hitKey) so they stop surfacing in the toast. */
  dismissed: Record<string, true>
  /** When armed, detected corrections auto-push without a confirm click. */
  armed: boolean
  /**
   * Record that `nodeId` consumed `facts` (the live Board snapshot that was
   * injected). Maps each fact to its normalized (subject,value) via the pure
   * helper, appends to the node's bounded ring, and ignores facts with no
   * concrete subject/value. Called from BriefBoard.inject() right after the
   * enqueueForTarget that performs the injection.
   */
  recordInjection: (nodeId: string, facts: BoardFact[]) => void
  /**
   * Compute the currently-stale (node, subject) hits against the LIVE Board facts
   * (read lazily at call time). Excludes hits already pushed or dismissed. Pure
   * w.r.t. its own state; reads useBoard.getState() inside.
   */
  detectStale: () => StaleHit[]
  /**
   * Push ONE correction to its node through the relay drain, then mark its hitKey
   * as pushed so it never re-fires. No-op if already pushed. Returns true if
   * delivered.
   */
  pushCorrection: (hit: StaleHit) => boolean
  /** Operator dismissed a hit (won't push, won't resurface). */
  dismiss: (hit: StaleHit) => void
  /** Toggle auto-push. When turning ON, immediately flushes current hits. */
  toggleArmed: () => void
  /** Auto-push every currently-detected hit (used when armed). */
  pushAllDetected: () => void
  /** Wipe the whole store (registered into resetRelayAndMission via canvas hook). */
  clear: () => void
}

export const useContextSync = create<ContextSyncState>((set, get) => ({
  ledger: {},
  pushed: {},
  dismissed: {},
  armed: false,

  recordInjection: (nodeId, facts) => {
    if (!nodeId || !facts || facts.length === 0) return
    const now = Date.now()
    const add: ConsumedFact[] = []
    for (const f of facts) {
      const cv = consumedFromFact(f)
      if (!cv) continue
      // Record the consumption time as NOW (when it was injected), not the fact's
      // pin ts: the recency guard in computeStale compares a later Board change
      // against WHEN the node received the value.
      add.push({ subject: cv.subject, value: cv.value, ts: now })
    }
    if (add.length === 0) return
    set((s) => {
      const prev = s.ledger[nodeId] ? [...s.ledger[nodeId], ...add] : add
      const next = prev.length > MAX_PER_NODE ? prev.slice(-MAX_PER_NODE) : prev
      return { ledger: { ...s.ledger, [nodeId]: next } }
    })
  },

  detectStale: () => {
    const { ledger, pushed, dismissed } = get()
    const keys = Object.keys(ledger)
    if (keys.length === 0) return []
    const map: Ledger = new Map()
    for (const k of keys) map.set(k, ledger[k])
    let facts: BoardFact[] = []
    try {
      facts = useBoard.getState().facts
    } catch {
      return []
    }
    return computeStale(map, facts).filter((h) => {
      const k = hitKey(h)
      return !pushed[k] && !dismissed[k]
    })
  },

  pushCorrection: (hit) => {
    const k = hitKey(hit)
    if (get().pushed[k]) return false
    let ok = false
    try {
      ok = useRelay.getState().enqueueForTarget(hit.nodeId, formatCorrection(hit))
    } catch {
      ok = false
    }
    // Mark pushed regardless of queue acceptance so a closed/unknown target never
    // re-fires the same correction every tick; the hit has been acted upon.
    set((s) => ({ pushed: { ...s.pushed, [k]: true } }))
    return ok
  },

  dismiss: (hit) => {
    const k = hitKey(hit)
    set((s) => ({ dismissed: { ...s.dismissed, [k]: true } }))
  },

  toggleArmed: () => {
    const next = !get().armed
    set({ armed: next })
    if (next) get().pushAllDetected()
  },

  pushAllDetected: () => {
    for (const h of get().detectStale()) get().pushCorrection(h)
  },

  clear: () => set({ ledger: {}, pushed: {}, dismissed: {}, armed: false })
}))

// Register the full-reset hook so new_canvas / loadLayout / bootRecipe wipe the
// consumption ledger + pushed/dismissed sets, alongside resetRelayAndMission.
// Reached lazily through canvas.ts's registry to keep the one-directional-import
// contract (contextSync.ts imports canvas.ts for this registry, never the reverse).
registerContextSyncReset(() => {
  useContextSync.getState().clear()
})
