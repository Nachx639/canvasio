// stall.ts
//
// Stall Watch — the autonomous blocked-agent rescue watchdog. Every other
// agent-intelligence surface CanvasIO has is either passive OBSERVABILITY
// (Mission Pulse/Brief, Agent Lens, Pulse Radar, Director/Replay, status dots) or
// STATIC orchestration that fires only on a clean done/error transition (Agent
// Relay, Smart Relay). The one moment that actually wastes the operator's time —
// an agent that goes `waiting` (needs-input) or `error` and then just SITS there
// while they're heads-down in another window — had no automation at all.
//
// When ARMED, Stall Watch subscribes to the live Mission Pulse feed (the exact
// pattern director.ts uses) plus a slow tick, and detects a STALL: a node whose
// CURRENT canvas status is 'waiting' or 'error' AND whose most-recent mission
// event is older than STALL_MS with no newer activity. On a confirmed stall it
// records the stall (surfaced by StallWatchToast) and narrates ONE Spanish line.
// Optional auto-nudge composes a Board-backed rescue and delivers it through the
// SAME readiness-gated relay drain path (enqueueForTarget -> deliverRelay) that
// handoffs already ride. It re-arms per node only after fresh activity, so it
// never spams.
//
// Design contract (mirrors director.ts / mission.ts / relay.ts / board.ts):
//   - PURE RENDERER, in-memory ONLY. Never persisted, never serialized into
//     canvasio:layout, never touches IPC or the main process.
//   - SELF-CANCELLING. The module-scope subscription + interval are always torn
//     down on disarm(), so they can never leak or double-run.
//   - POLITE / NO-SPAM. Auto-nudge fires at most ONCE per stall; narrates at most
//     one line per stall; a node re-arms only after it shows fresh activity.
//   - DEFERS TO RELAY. If a node already has a queued relay instruction awaiting
//     delivery, auto-nudge skips it (don't double-deliver). Manual Nudge always
//     allowed.
//
// One-directional imports only (stall -> canvas / mission / relay / board / lens
// / narration / stallRescue); none of those import stall, so there is no cycle.
// canvas.ts deliberately does NOT statically import this module (exactly like it
// never imports director.ts); the full-reset hook reaches it lazily via getState.

import { create } from 'zustand'
import { useCanvas, registerStallReset } from './canvas'
import { useMission } from './mission'
import { useRelay } from './relay'
import { useBoard } from './board'
import { useLens } from './lens'
import { narrateBrief } from '../lib/narration'
import { composeRescue, isStalled } from '../lib/stallRescue'
import { t } from './i18n'

/** How long a node must sit in waiting/error with no fresh event before it stalls. */
const STALL_MS = 45000
/** Tick cadence: a node can stall purely from the passage of time (no new event). */
const TICK_MS = 10000

/** A single recorded stall for one node. */
export interface StallEntry {
  /** which blocked state it stalled in. */
  kind: 'waiting' | 'error'
  /** wall-clock ms when we first confirmed the stall. */
  since: number
  /** ts of the node's most-recent mission event at detection time (the watermark). */
  lastEventTs: number
  /** true once a Nudge (manual OR auto) has been delivered for THIS stall. */
  nudged: boolean
}

interface StallState {
  /** True while Stall Watch is live-watching. Controls StallWatchToast visibility. */
  armed: boolean
  /** When true, a confirmed stall is auto-nudged once (no operator click needed). */
  autoNudge: boolean
  /** Current stalls, keyed by nodeId. Cleared/re-armed per node on fresh activity. */
  stalls: Record<string, StallEntry>

  arm: () => void
  disarm: () => void
  toggle: () => void
  /** Tear down + wipe stalls (called from the canvas full-reset surface). */
  disarmAndClear: () => void
  setAutoNudge: (v: boolean) => void
  toggleAutoNudge: () => void
  /**
   * Deliver a Board-backed rescue to a stalled node through the relay drain path
   * and mark its stall nudged. Returns true if something was enqueued. Used by
   * the StallWatchToast "Nudge" button and by the auto-nudge path.
   */
  nudge: (nodeId: string) => boolean
}

// Module-scope handles, mirroring director.ts. Only ONE of each is ever live;
// teardown() clears them both.
let unsubMission: (() => void) | null = null
let tickTimer: ReturnType<typeof setInterval> | null = null

function teardown(): void {
  if (unsubMission) {
    unsubMission()
    unsubMission = null
  }
  if (tickTimer != null) {
    clearInterval(tickTimer)
    tickTimer = null
  }
}

/** ts of the most-recent mission event for each node (0 when it has none). */
function lastEventTsByNode(): Map<string, number> {
  const last = new Map<string, number>()
  for (const ev of useMission.getState().events) {
    const prev = last.get(ev.nodeId)
    if (prev == null || ev.ts > prev) last.set(ev.nodeId, ev.ts)
  }
  return last
}

export const useStall = create<StallState>((set, get) => {
  /**
   * The single scan: fold the live canvas nodes + mission watermarks + the
   * STALL_MS threshold into the current stall set. Deterministic per call.
   *  - A live terminal node whose status is waiting/error AND whose newest event
   *    is older than STALL_MS becomes (or stays) a stall.
   *  - A fresh event for a node (newer than its recorded stall watermark) CLEARS
   *    its stall — it re-arms and can stall again later (watermark discipline,
   *    mirroring director.ts's lastTs).
   *  - On a NEW stall: narrate one line, and auto-nudge once if enabled + allowed.
   */
  const scan = (): void => {
    if (!get().armed) return
    const now = Date.now()
    const nodes = useCanvas.getState().nodes
    const lastTs = lastEventTsByNode()
    const prev = get().stalls

    const next: Record<string, StallEntry> = {}
    const newlyStalled: { nodeId: string; kind: 'waiting' | 'error' }[] = []

    for (const n of nodes) {
      // Only watch live terminal nodes (music/web never "stall").
      if (n.kind !== 'terminal') continue
      const evTs = lastTs.get(n.id) ?? 0
      const kind = isStalled(n.status, evTs, now, STALL_MS)
      const existing = prev[n.id]

      if (!kind) {
        // Not stalled now — drop any prior stall (node recovered / is working).
        continue
      }

      if (existing) {
        // Already recorded. Fresh activity (a newer event than our watermark)
        // means the node moved — clear the stall so it can re-arm cleanly.
        if (evTs > existing.lastEventTs) {
          // Re-evaluate: it's still waiting/error but with a NEWER event, so the
          // STALL_MS clock restarts. isStalled already required age >= STALL_MS,
          // so reaching here means the new event is itself already old enough; in
          // practice the tick will re-detect it next pass. Treat as a fresh stall.
          next[n.id] = { kind, since: now, lastEventTs: evTs, nudged: false }
          newlyStalled.push({ nodeId: n.id, kind })
        } else {
          // Same stall, carry it forward unchanged (keeps `since` + `nudged`).
          next[n.id] = existing
        }
      } else {
        // Brand-new stall.
        next[n.id] = { kind, since: now, lastEventTs: evTs, nudged: false }
        newlyStalled.push({ nodeId: n.id, kind })
      }
    }

    // Only write when something actually changed (avoid churning subscribers).
    const changed =
      Object.keys(next).length !== Object.keys(prev).length ||
      Object.keys(next).some((id) => next[id] !== prev[id])
    if (changed) set({ stalls: next })

    // Side-effects for brand-new stalls: one narration line, optional auto-nudge.
    for (const s of newlyStalled) {
      const node = nodes.find((n) => n.id === s.nodeId)
      const name = (node?.title || t('stall.default_agent')).trim()
      // Blocked duration = how long since the node's last activity (its watermark).
      const blockedMs = Math.max(STALL_MS, now - (next[s.nodeId]?.lastEventTs ?? now))
      // Narrate exactly one line per stall (rides the shared narration queue).
      narrateBrief(
        s.kind === 'error'
          ? t('stall.blocked_error', { name, duration: formatAgo(blockedMs) })
          : t('stall.blocked', { name, duration: formatAgo(blockedMs) })
      )
      // Auto-nudge: at most once per stall, and only if no relay delivery is
      // already pending for this node (defer to relay / Smart Relay).
      if (get().autoNudge) {
        const pending = useRelay.getState().queue[s.nodeId]
        if (!pending || pending.length === 0) {
          get().nudge(s.nodeId)
        }
      }
    }
  }

  return {
    armed: false,
    autoNudge: false,
    stalls: {},

    arm: () => {
      if (get().armed) return
      teardown()
      set({ armed: true, stalls: {} })
      // Live feed: any new mission event may clear or create a stall — re-scan.
      unsubMission = useMission.subscribe(() => {
        if (get().armed) scan()
      })
      // Slow tick: a node can stall purely by sitting still (no new event), so
      // we must also re-evaluate the elapsed-time threshold on a timer.
      tickTimer = setInterval(() => {
        if (get().armed) scan()
      }, TICK_MS)
    },

    disarm: () => {
      teardown()
      set({ armed: false })
    },

    toggle: () => {
      if (get().armed) get().disarm()
      else get().arm()
    },

    disarmAndClear: () => {
      teardown()
      set({ armed: false, stalls: {} })
    },

    setAutoNudge: (v) => set({ autoNudge: v }),
    toggleAutoNudge: () => set((s) => ({ autoNudge: !s.autoNudge })),

    nudge: (nodeId) => {
      const entry = get().stalls[nodeId]
      const facts = useBoard.getState().facts
      const lens = useLens.getState().lines[nodeId]?.text ?? null
      const text = composeRescue(nodeId, facts, lens)
      // Even with no board/lens context, give the stuck agent SOMETHING actionable.
      const body = text || t('stall.rescue_fallback')
      const ok = useRelay.getState().enqueueForTarget(nodeId, body)
      // Mark the stall nudged (idempotent) so the toast reflects it and auto-nudge
      // never re-fires for the same stall.
      if (ok && entry) {
        set((s) => ({
          stalls: { ...s.stalls, [nodeId]: { ...s.stalls[nodeId], nudged: true } }
        }))
      }
      return ok
    }
  }
})

// Register the full-reset hook so new_canvas / loadLayout / bootRecipe disarm
// Stall Watch and wipe its stalls (orphan cleanup), alongside resetRelayAndMission.
// Reached lazily through canvas.ts's registry to keep the one-directional-import
// contract (stall.ts imports canvas.ts, never the reverse).
registerStallReset(() => {
  useStall.getState().disarmAndClear()
})

/** Human "Nms"-ish Spanish duration for the narration line (e.g. "1m", "45s"). */
function formatAgo(ms: number): string {
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  const rem = s % 60
  return rem ? `${m}m${rem}s` : `${m}m`
}
