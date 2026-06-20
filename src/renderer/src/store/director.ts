// director.ts
//
// Director Mode — the LIVE counterpart to the cinematic Replay. CanvasIO already
// records every meaningful status transition into the in-memory Mission Pulse
// store (mission.ts) at one chokepoint, and already has a buttery camera fly-to
// tween (centerOnNode in canvas.ts). Replay tours the PAST; Director flies the
// camera to whichever agent demands attention the MOMENT it happens.
//
// When armed, it subscribes to the live Mission Pulse feed and, on each NEW
// meaningful event, auto-flies to that node with smart attention priority
// (error > waiting/needs-input > relay handoff > work-start). Quiet kinds
// (done / idle / close / spawn) never steal focus. A burst of simultaneous
// transitions is debounced to the single highest-priority target.
//
// Design contract (mirrors replay.ts / mission.ts):
//   - PURE RENDERER, in-memory ONLY. Never persisted, never serialized into
//     canvasio:layout, never touches IPC or the main process.
//   - CAMERA-ONLY. It drives useCanvas.centerOnNode (camera, never geometry).
//   - SELF-CANCELLING. The module-scope subscriptions and debounce timer are
//     always torn down on disarm(), so they can never leak or double-run.
//   - POLITE. Any manual pan/zoom/minimap drag (a camera change we did NOT
//     initiate) instantly disarms follow — it never fights the user.
//   - DEFERS TO REPLAY. While a replay is armed it skips entirely (replay owns
//     the camera). No mutation of the replay store.
//
// One-directional imports only (director -> canvas / mission / replay); none of
// those import director, so there is no cycle.

import { create } from 'zustand'
import { useCanvas, pauseVisitRecording } from './canvas'
import { useMission, type MissionKind } from './mission'
import { useReplay } from './replay'

/** Debounce window to collapse a burst of simultaneous transitions, in ms. */
const DEBOUNCE_MS = 120

/**
 * Attention priority: higher wins when several new events arrive together.
 * Quiet kinds are intentionally absent (priority 0) and never steal focus.
 */
const PRIORITY: Record<MissionKind, number> = {
  error: 4,
  waiting: 3,
  relay: 2,
  'work-start': 1,
  // quiet — never followed
  spawn: 0,
  done: 0,
  close: 0
}

interface DirectorState {
  /** True while Director is live-following. Controls DirectorChip visibility. */
  armed: boolean
  /** Node id the camera is currently following (last flown-to target), or null. */
  followingNodeId: string | null
  /** Only events with ts > lastTs are considered; advanced as we follow. */
  lastTs: number

  /** Arm live-follow. Seeds lastTs=now so it only reacts to FUTURE events. */
  arm: () => void
  /** Disarm and tear down all subscriptions + the debounce timer. */
  disarm: () => void
  /** Toggle armed state. */
  toggle: () => void
}

// Module-scope subscription handles + debounce timer, mirroring replay.ts's
// dwellTimer pattern. Only ONE of each is ever live; disarm() clears them all.
let unsubMission: (() => void) | null = null
let unsubCanvas: (() => void) | null = null
let debounceTimer: ReturnType<typeof setTimeout> | null = null

/**
 * Set right before WE call centerOnNode and cleared shortly after, so the
 * canvas subscription can tell our own camera moves apart from a manual
 * pan/zoom/minimap drag (which must disarm follow). Mirrors the "manual
 * interaction wins" philosophy already documented in canvas.ts.
 */
let expecting = false

function clearTimers(): void {
  if (debounceTimer != null) {
    clearTimeout(debounceTimer)
    debounceTimer = null
  }
}

function teardown(): void {
  clearTimers()
  if (unsubMission) {
    unsubMission()
    unsubMission = null
  }
  if (unsubCanvas) {
    unsubCanvas()
    unsubCanvas = null
  }
  expecting = false
}

export const useDirector = create<DirectorState>((set, get) => {
  /**
   * Inspect the events newer than lastTs, pick the single highest-priority
   * meaningful target, and fly to it. Quiet kinds are ignored. Defers entirely
   * while a replay is armed.
   */
  const considerNewEvents = (): void => {
    clearTimers()
    if (!get().armed) return
    // Replay owns the camera while it is armed — stay out of its way.
    if (useReplay.getState().armed) return

    const { lastTs } = get()
    const events = useMission.getState().events
    const nodes = useCanvas.getState().nodes

    let best: { nodeId: string; ts: number; prio: number } | null = null
    let maxTs = lastTs
    for (const ev of events) {
      if (ev.ts <= lastTs) continue
      if (ev.ts > maxTs) maxTs = ev.ts
      const prio = PRIORITY[ev.kind]
      if (prio <= 0) continue
      // Skip events whose node no longer exists (centerOnNode would no-op).
      if (!nodes.some((n) => n.id === ev.nodeId)) continue
      // Highest priority wins; on a tie, the most recent event wins.
      if (!best || prio > best.prio || (prio === best.prio && ev.ts >= best.ts)) {
        best = { nodeId: ev.nodeId, ts: ev.ts, prio }
      }
    }

    // Advance the watermark past everything we've now seen so the same events
    // never re-trigger, even if no target was worth following.
    if (maxTs > lastTs) set({ lastTs: maxTs })

    if (!best) return

    // Fly the camera. Mark `expecting` so our own setCamera frames don't look
    // like a manual interaction to the canvas subscription below.
    expecting = true
    set({ followingNodeId: best.nodeId })
    // Wayback — Director is an AUTOMATED live-follow tour, so pause visit recording
    // around the programmatic fly so it never pollutes the user's frecency recents
    // / the ` quick-switch pair (only manual jumps should count).
    pauseVisitRecording(true)
    try {
      useCanvas.getState().centerOnNode(best.nodeId)
    } finally {
      pauseVisitRecording(false)
    }
    // The centerOnNode tween runs over ~280ms; keep `expecting` set a touch
    // longer than the tween so none of its frames are mistaken for a manual pan.
    setTimeout(() => {
      expecting = false
    }, 360)
  }

  return {
    armed: false,
    followingNodeId: null,
    lastTs: 0,

    arm: () => {
      if (get().armed) return
      teardown()
      // Seed the watermark to NOW so arming never yanks the camera to a stale
      // event; Director only reacts to events that happen AFTER it is armed.
      set({ armed: true, followingNodeId: null, lastTs: Date.now() })

      // Live feed: debounce a burst of transitions into a single best target.
      unsubMission = useMission.subscribe(() => {
        if (!get().armed) return
        clearTimers()
        debounceTimer = setTimeout(considerNewEvents, DEBOUNCE_MS)
      })

      // Yield-to-user: any camera change we did NOT initiate disarms follow.
      // panBy / zoomAt / minimap setCamera all flow through here.
      let prevCamera = useCanvas.getState().camera
      unsubCanvas = useCanvas.subscribe((s) => {
        if (s.camera === prevCamera) return
        prevCamera = s.camera
        if (!get().armed) return
        if (expecting) return // our own centerOnNode tween — ignore
        get().disarm()
      })
    },

    disarm: () => {
      teardown()
      set({ armed: false, followingNodeId: null })
    },

    toggle: () => {
      if (get().armed) get().disarm()
      else get().arm()
    }
  }
})
