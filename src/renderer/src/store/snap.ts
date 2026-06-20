// snap.ts
//
// Magnetic Align — the TRANSIENT guide-line bus.
//
// A tiny renderer-only zustand store that carries the WORLD-SPACE guide segments
// that are currently flashing under an active window drag, plus the live Alt-held
// flag. NodeView publishes guides on each snapped pointer-move and clears them on
// pointer-up; the SnapGuides overlay subscribes and draws them in screen space.
//
// Design contract (mirrors the jumpMode/peekNodeId transient flags on canvas.ts):
//   - PURE RENDERER, in-memory ONLY. NEVER persisted to canvasio:layout, NEVER
//     serialized, NEVER sent over IPC or to the main process.
//   - Holds NO geometry of its own — only the ephemeral guide segments to draw
//     for the in-flight gesture, cleared the instant the drag ends.
//   - One-directional imports: snap -> snapGuides (types only). Nothing imports
//     back, so there is no cycle.

import { create } from 'zustand'
import type { GuideLine } from '../lib/snapGuides'

interface SnapState {
  /** the guide segments to flash for the in-flight drag (world space). */
  guides: GuideLine[]
  /** true while Alt is held during a drag (snapping suspended — for HUD cues). */
  altHeld: boolean
  /** Publish the active guides for the current move frame. */
  setGuides: (guides: GuideLine[]) => void
  /** Reflect the Alt-held (free-placement) state. */
  setAltHeld: (alt: boolean) => void
  /** Clear all guides + reset alt — called on pointer-up / gesture end. */
  clearGuides: () => void
}

export const useSnap = create<SnapState>((set) => ({
  guides: [],
  altHeld: false,
  setGuides: (guides) => set({ guides }),
  setAltHeld: (altHeld) => set({ altHeld }),
  clearGuides: () => set({ guides: [], altHeld: false })
}))
