// replay.ts
//
// Flight Recorder Replay — a cinematic playback engine for the Mission Pulse
// timeline. CanvasIO already records a full chronological "flight recorder" of
// every meaningful canvas event in the in-memory Mission Pulse store
// (mission.ts), and it already has a buttery camera fly-to tween (centerOnNode
// in canvas.ts). This store connects the two: it flies the camera from event to
// event in chronological order so you can re-live a work session as a guided
// spatial tour instead of re-reading a static log.
//
// Design contract (mirrors mission.ts):
//   - PURE RENDERER, in-memory ONLY. Never persisted, never serialized into
//     canvasio:layout, never touches IPC or the main process.
//   - CAMERA-ONLY. It drives useCanvas.centerOnNode (which moves only the
//     camera, never node/shape geometry). Zero mutation of canvas content.
//   - SNAPSHOT-STABLE. start() captures an immutable snapshot of the timeline so
//     live new events appended mid-replay never shift the playhead.
//   - SELF-CANCELLING. The playback timer is module-scope and always cleared on
//     stop()/togglePlay()/setSpeed()/stepTo(), so it can never leak or double-run.
//
// It imports canvas.ts and mission.ts only (no cycle: mission.ts imports a type
// from canvas.ts; canvas.ts imports neither of these).

import { create } from 'zustand'
import { useCanvas, pauseVisitRecording } from './canvas'
import { useMission, type MissionEvent } from './mission'

/** Camera dwell on each event at 1x speed, in ms. Divided by speed. */
const DWELL_BASE_MS = 1400

export type ReplaySpeed = 1 | 2 | 4

interface ReplayState {
  /** True once a replay has been armed (started) and not yet stopped. Controls ReplayBar visibility. */
  armed: boolean
  /** True while the camera is auto-advancing; false when paused (but still armed). */
  isPlaying: boolean
  /** Current playhead index into `snapshot`. */
  index: number
  /** Playback speed multiplier. */
  speed: ReplaySpeed
  /** Immutable copy of useMission.events captured at start(); the timeline being replayed. */
  snapshot: MissionEvent[]

  /** Arm + begin replay from the first event. No-op if the timeline is empty. */
  start: () => void
  /** Stop, disarm and clear (hides the transport, releases the camera). */
  stop: () => void
  /** Play/pause toggle (stays armed). */
  togglePlay: () => void
  /** Jump the playhead to a specific index (used by the scrubber); snaps the camera. */
  stepTo: (i: number) => void
  /** Advance one event (clamped at the end). */
  next: () => void
  /** Go back one event (clamped at 0). */
  prev: () => void
  /** Change playback speed; reschedules the running timer if playing. */
  setSpeed: (s: ReplaySpeed) => void
}

// Module-scope playback timer, mirroring the flyRaf pattern in canvas.ts. Only
// ONE timer is ever pending; every state transition clears it first.
let dwellTimer: ReturnType<typeof setTimeout> | null = null

function clearTimer(): void {
  if (dwellTimer != null) {
    clearTimeout(dwellTimer)
    dwellTimer = null
  }
}

/**
 * Fly the camera to the event at `i`. centerOnNode is a no-op for unknown ids
 * (e.g. a node that was closed after the event was recorded), so a missing node
 * simply leaves the camera where it is — safe and intentional.
 */
function focusEvent(ev: MissionEvent | undefined): void {
  if (!ev) return
  const nodes = useCanvas.getState().nodes
  if (nodes.some((n) => n.id === ev.nodeId)) {
    // Wayback — a replay is an AUTOMATED tour, so pause visit recording around the
    // programmatic fly so a passive flythrough never pollutes the user's frecency
    // recents / the ` quick-switch pair.
    pauseVisitRecording(true)
    try {
      useCanvas.getState().centerOnNode(ev.nodeId)
    } finally {
      pauseVisitRecording(false)
    }
  }
}

export const useReplay = create<ReplayState>((set, get) => {
  /** (Re)arm the dwell timer to advance from the current index after the dwell. */
  const schedule = (): void => {
    clearTimer()
    const { isPlaying, speed } = get()
    if (!isPlaying) return
    const wait = Math.max(250, Math.round(DWELL_BASE_MS / speed))
    dwellTimer = setTimeout(() => {
      const s = get()
      if (!s.isPlaying) return
      const last = s.snapshot.length - 1
      if (s.index >= last) {
        // Reached the end: gently stop but stay armed so the transport remains
        // visible at the final frame (user can scrub back or replay).
        clearTimer()
        set({ isPlaying: false })
        return
      }
      const nextIdx = s.index + 1
      set({ index: nextIdx })
      focusEvent(s.snapshot[nextIdx])
      schedule()
    }, wait)
  }

  return {
    armed: false,
    isPlaying: false,
    index: 0,
    speed: 1,
    snapshot: [],

    start: () => {
      const events = useMission.getState().events
      if (events.length === 0) return
      clearTimer()
      const snapshot = [...events]
      set({ armed: true, isPlaying: true, index: 0, snapshot })
      focusEvent(snapshot[0])
      schedule()
    },

    stop: () => {
      clearTimer()
      set({ armed: false, isPlaying: false, index: 0, snapshot: [] })
    },

    togglePlay: () => {
      const s = get()
      if (!s.armed || s.snapshot.length === 0) return
      if (s.isPlaying) {
        clearTimer()
        set({ isPlaying: false })
      } else {
        // If paused at the very end, restart from the top; otherwise resume.
        const atEnd = s.index >= s.snapshot.length - 1
        const index = atEnd ? 0 : s.index
        set({ isPlaying: true, index })
        focusEvent(s.snapshot[index])
        schedule()
      }
    },

    stepTo: (i) => {
      const s = get()
      if (s.snapshot.length === 0) return
      const index = Math.max(0, Math.min(i, s.snapshot.length - 1))
      clearTimer()
      // Manual scrubbing pauses auto-advance so the user keeps control.
      set({ index, isPlaying: false })
      focusEvent(s.snapshot[index])
    },

    next: () => get().stepTo(get().index + 1),
    prev: () => get().stepTo(get().index - 1),

    setSpeed: (speed) => {
      set({ speed })
      // Reschedule with the new cadence if currently auto-advancing.
      if (get().isPlaying) schedule()
    }
  }
})
