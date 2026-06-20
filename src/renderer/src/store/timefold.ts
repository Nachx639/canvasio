// timefold.ts (store)
//
// Timefold — Canvas Time Machine. A single bottom-edge scrubber that rewinds the
// ENTIRE canvas to any past wall-clock moment. As the playhead moves, every
// in-world terminal renders a frozen "as-of T" overlay reconstructing the line
// it was printing and the status it held at that instant — so you see the whole
// multi-agent session frozen in space, all windows at once.
//
// This store holds only the scrub STATE (armed / current t / range). The actual
// reconstruction is the pure kernel in lib/timefold.ts; the per-node frozen
// overlay is rendered by NodeView reading that kernel. It reuses 100% existing
// in-memory data: the Echo Index ring (echo.ts) + Mission Pulse log (mission.ts).
//
// Design contract (mirrors replay.ts / director.ts / tour.ts):
//   - PURE RENDERER, in-memory ONLY. Never persisted, never serialized into
//     canvasio:layout, never touches IPC or the main process. A fresh / restored
//     canvas starts with an empty range, so arm() is a no-op there.
//   - READ-ONLY over Echo / Mission / Canvas. It mutates NO node/shape geometry.
//   - CAMERA-ONLY moves funnel through the existing centerOnBounds tween.
//   - SELF-CANCELLING. The module-scope camera subscription is always torn down
//     on disarm(), so it can never leak or double-run.
//   - POLITE. A manual pan/zoom we did not initiate (the framePast tween aside)
//     exits the scrub — it never fights the user.
//   - DEFERS to Replay / Director / Tour. arm() bails while any owns the camera.
//
// One-directional imports only (timefold -> canvas / echo / mission / replay /
// director / tour); none of those import this store, so there is no cycle.

import { create } from 'zustand'
import { useCanvas, pauseVisitRecording } from './canvas'
import { useEcho } from './echo'
import { useMission } from './mission'
import { useReplay } from './replay'
import { useDirector } from './director'
import { useTour } from './tour'
import { computeRange, neighborTick, eventTicks, lineAtTime, type TimefoldRange } from '../lib/timefold'

interface TimefoldState {
  /** True while the time machine is active. Controls TimefoldBar + frozen overlays. */
  armed: boolean
  /** Current scrub instant (wall-clock ms), or null when disarmed. */
  t: number | null
  /** Span captured at arm() time; null when there was nothing to scrub. */
  range: TimefoldRange | null

  /** Arm: snapshot the range, seed t=maxTs (the live edge). No-op if empty / busy. */
  arm: () => void
  /** Clamp + set the scrub instant. */
  setT: (t: number) => void
  /** Hop the playhead to the prev/next real event tick (arrow-stepping). */
  stepTick: (dir: 1 | -1) => void
  /** Camera-only: fit all nodes that have data as-of t (via centerOnBounds). */
  framePast: () => void
  /** Disarm: snap back to live, tear down the camera watcher. */
  disarm: () => void
  /** Toggle armed state. */
  toggle: () => void
}

// Module-scope camera subscription, mirroring director.ts/tour.ts. Only ONE is
// ever live; disarm() clears it.
let unsubCanvas: (() => void) | null = null

/**
 * Set right before WE drive the camera (framePast) and cleared shortly after, so
 * the canvas subscription can tell our own centerOnBounds tween apart from a
 * manual pan/zoom/minimap drag (which must exit the scrub). Mirrors director.ts.
 */
let expecting = false

function teardown(): void {
  if (unsubCanvas) {
    unsubCanvas()
    unsubCanvas = null
  }
  expecting = false
}

export const useTimefold = create<TimefoldState>((set, get) => ({
  armed: false,
  t: null,
  range: null,

  arm: () => {
    if (get().armed) return
    // Defer to the camera owners — never fight an active cinematic mode.
    if (useReplay.getState().armed) return
    if (useDirector.getState().armed) return
    if (useTour.getState().armed) return

    const range = computeRange(useEcho.getState().entries, useMission.getState().events)
    if (!range) return // nothing recorded yet → nothing to scrub

    teardown()
    // Seed at the live edge (maxTs) so arming shows "now" and the user scrubs back.
    set({ armed: true, range, t: range.maxTs })

    // Yield-to-user: any camera change we did NOT initiate exits the scrub.
    // panBy / zoomAt / minimap setCamera all flow through this subscription.
    let prevCamera = useCanvas.getState().camera
    unsubCanvas = useCanvas.subscribe((s) => {
      if (s.camera === prevCamera) return
      prevCamera = s.camera
      if (!get().armed) return
      if (expecting) return // our own framePast tween — ignore
      get().disarm()
    })
  },

  setT: (t) => {
    const { armed, range } = get()
    if (!armed || !range) return
    const clamped = Math.max(range.minTs, Math.min(t, range.maxTs))
    set({ t: clamped })
  },

  stepTick: (dir) => {
    const { armed, t } = get()
    if (!armed || t == null) return
    const ticks = eventTicks(useEcho.getState().entries, useMission.getState().events)
    const next = neighborTick(ticks, t, dir)
    if (next != null) get().setT(next)
  },

  framePast: () => {
    const { armed, t } = get()
    if (!armed || t == null) return
    // Fit the bounds of every live node that actually had output as-of t. Falls
    // back to no-op when nothing qualifies (centerOnBounds guards bad bounds too).
    const nodes = useCanvas.getState().nodes
    const echo = useEcho.getState().entries
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    let any = false
    for (const n of nodes) {
      if (!lineAtTime(echo[n.id], t)) continue
      any = true
      if (n.x < minX) minX = n.x
      if (n.y < minY) minY = n.y
      if (n.x + n.w > maxX) maxX = n.x + n.w
      if (n.y + n.h > maxY) maxY = n.y + n.h
    }
    if (!any || !Number.isFinite(minX)) return

    // Camera-only, bracketed exactly like director/tour: pauseVisitRecording so an
    // automated frame never pollutes Slipstream/Wayback, and `expecting` so our own
    // tween isn't mistaken for a manual pan by the watcher above.
    expecting = true
    pauseVisitRecording(true)
    try {
      useCanvas.getState().centerOnBounds({ x: minX, y: minY, w: maxX - minX, h: maxY - minY })
    } finally {
      pauseVisitRecording(false)
    }
    // centerOnBounds' flyCameraTo tween runs ~280ms; hold `expecting` a touch
    // longer so none of its frames look like a manual pan.
    setTimeout(() => {
      expecting = false
    }, 360)
  },

  disarm: () => {
    teardown()
    // Clearing t snaps every frozen overlay back to live (NodeView's selector
    // returns null), so the canvas resumes the present instantly.
    set({ armed: false, t: null, range: null })
  },

  toggle: () => {
    if (get().armed) get().disarm()
    else get().arm()
  }
}))
