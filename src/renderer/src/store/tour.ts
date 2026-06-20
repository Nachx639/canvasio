// tour.ts
//
// Grand Tour — a hands-free, looping cinematic PRESENTATION of your saved
// Waypoints. CanvasIO already lets you save up to 9 named camera bookmarks
// (Waypoints in canvas.ts) and JUMP to any one of them, and it already has a
// buttery eased camera fly-to tween (goWaypoint -> flyCameraTo). This store
// connects the two into a playback mode: it flies the camera waypoint ->
// waypoint in saved order, dwells a few seconds at each, then LOOPS — the
// canvas equivalent of Prezi/Miro "Presentation Mode".
//
// Where the siblings differ:
//   - Replay tours the PAST event log (mission.ts snapshot).
//   - Director chases LIVE events (mission.ts feed).
//   - Grand Tour is AUTHOR-driven: you curate the stops + order by saving
//     Waypoints, and the tour plays exactly that script, on a loop.
//
// Design contract (mirrors replay.ts / director.ts):
//   - PURE RENDERER, in-memory ONLY. Never persisted, never serialized into
//     canvasio:layout, never touches IPC or the main process.
//   - CAMERA-ONLY. It drives useCanvas.goWaypoint (camera tween, never
//     geometry). Zero mutation of canvas content.
//   - SELF-CANCELLING. The dwell timer + camera subscription are module-scope
//     and always torn down on stop(), so they can never leak or double-run.
//   - SNAPSHOT-STABLE. Every tick re-reads the live waypoints and clamps the
//     index, so deleting/adding waypoints mid-tour never crashes or skips off
//     the end (mirrors replay.ts snapshot discipline).
//   - POLITE. Any manual pan/zoom/minimap drag (a camera change we did NOT
//     initiate) instantly stops the tour — it never fights the user.
//   - DEFERS TO REPLAY/DIRECTOR. start() bails while either owns the camera.
//
// One-directional imports only (tour -> canvas / replay / director); none of
// those import tour, so there is no cycle.

import { create } from 'zustand'
import { useCanvas, pauseVisitRecording } from './canvas'
import { useReplay } from './replay'
import { useDirector } from './director'

/** Selectable dwell durations (ms) the TourBar steps through. */
export const DWELL_OPTIONS = [2000, 4000, 6000] as const
export type DwellMs = (typeof DWELL_OPTIONS)[number]

interface TourState {
  /** True once a tour is armed (started) and not yet stopped. Controls TourBar visibility. */
  armed: boolean
  /** True while auto-advancing; false when paused (but still armed). */
  paused: boolean
  /** Index of the waypoint currently spotlit. */
  index: number
  /** Total waypoints at the last tick — for the "n / N" caption. */
  total: number
  /** Dwell time on each waypoint, in ms. */
  dwellMs: DwellMs

  /** Arm + begin the tour from the first waypoint. No-op if <2 waypoints. */
  start: () => void
  /** Stop, disarm, release the camera (hides the transport). */
  stop: () => void
  /** Toggle the whole tour on/off (start when off, stop when on). */
  toggle: () => void
  /** Pause/resume auto-advance toggle (stays armed). */
  togglePause: () => void
  /** Advance to the next waypoint (loops); reschedules the dwell. */
  next: () => void
  /** Go to the previous waypoint (loops); reschedules the dwell. */
  prev: () => void
  /** Change the dwell duration; reschedules the running timer if playing. */
  setDwell: (ms: DwellMs) => void
}

// Module-scope dwell timer + camera subscription, mirroring replay.ts's
// dwellTimer / director.ts's unsubCanvas. Only ONE of each is ever live; stop()
// clears them both.
let dwellTimer: ReturnType<typeof setTimeout> | null = null
let unsubCanvas: (() => void) | null = null

/**
 * Set right before WE drive the camera and cleared shortly after, so the canvas
 * subscription can tell our own tween frames apart from a manual pan/zoom/
 * minimap drag (which must stop the tour). Mirrors director.ts:80.
 */
let expecting = false

function clearTimer(): void {
  if (dwellTimer != null) {
    clearTimeout(dwellTimer)
    dwellTimer = null
  }
}

function teardown(): void {
  clearTimer()
  if (unsubCanvas) {
    unsubCanvas()
    unsubCanvas = null
  }
  expecting = false
}

/**
 * Fly the camera to the waypoint at `i`, bracketing the programmatic move with
 * pauseVisitRecording + the `expecting` flag (so neither Wayback/Slipstream
 * history nor the yield-to-user watcher sees an automated tour hop as a manual
 * jump). Mirrors replay.ts:focusEvent / director.ts:considerNewEvents.
 */
function flyTo(id: string): void {
  expecting = true
  pauseVisitRecording(true)
  try {
    useCanvas.getState().goWaypoint(id)
  } finally {
    pauseVisitRecording(false)
  }
  // goWaypoint's flyCameraTo tween runs over ~280ms; hold `expecting` a touch
  // longer than the tween so none of its frames look like a manual pan.
  setTimeout(() => {
    expecting = false
  }, 360)
}

export const useTour = create<TourState>((set, get) => {
  /**
   * Move to waypoint at logical position `i` (wrapping). Re-reads the live
   * waypoints every call so a deleted/added waypoint never desyncs the index;
   * stops cleanly if the list dropped below 2.
   */
  const goTo = (i: number): void => {
    const wps = useCanvas.getState().waypoints
    if (wps.length < 2) {
      get().stop()
      return
    }
    const total = wps.length
    const index = ((i % total) + total) % total
    set({ index, total })
    flyTo(wps[index].id)
  }

  /** (Re)arm the dwell timer to advance from the current index after dwellMs. */
  const schedule = (): void => {
    clearTimer()
    if (get().paused) return
    dwellTimer = setTimeout(() => {
      if (!get().armed || get().paused) return
      goTo(get().index + 1)
      schedule()
    }, get().dwellMs)
  }

  return {
    armed: false,
    paused: false,
    index: 0,
    total: 0,
    dwellMs: DWELL_OPTIONS[1],

    start: () => {
      if (get().armed) return
      // Replay / Director own the camera while active — stay out of their way.
      if (useReplay.getState().armed) return
      if (useDirector.getState().armed) return
      const wps = useCanvas.getState().waypoints
      if (wps.length < 2) return // nothing to tour

      teardown()
      set({ armed: true, paused: false, index: 0, total: wps.length })

      // Yield-to-user: any camera change we did NOT initiate stops the tour.
      // panBy / zoomAt / minimap setCamera all flow through this subscription.
      let prevCamera = useCanvas.getState().camera
      unsubCanvas = useCanvas.subscribe((s) => {
        if (s.camera === prevCamera) return
        prevCamera = s.camera
        if (!get().armed) return
        if (expecting) return // our own goWaypoint tween — ignore
        get().stop()
      })

      flyTo(wps[0].id)
      schedule()
    },

    stop: () => {
      teardown()
      set({ armed: false, paused: false, index: 0, total: 0 })
    },

    toggle: () => {
      if (get().armed) get().stop()
      else get().start()
    },

    togglePause: () => {
      if (!get().armed) return
      const paused = !get().paused
      set({ paused })
      if (paused) clearTimer()
      else schedule()
    },

    next: () => {
      if (!get().armed) return
      goTo(get().index + 1)
      schedule()
    },

    prev: () => {
      if (!get().armed) return
      goTo(get().index - 1)
      schedule()
    },

    setDwell: (dwellMs) => {
      set({ dwellMs })
      if (get().armed && !get().paused) schedule()
    }
  }
})
