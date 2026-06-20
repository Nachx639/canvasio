// lens.ts
//
// Agent Lens — the live "what is it actually DOING right now" store. Every other
// observability surface (Mission Pulse, Mission Brief, Replay, Pulse Radar,
// status dots) answers "what STATE is each agent in and for how long". None
// answer the question you ask all day: the single most-recent meaningful line of
// output the agent just printed ("Editing src/main/pty.ts…", "Running 142
// tests…", "Allow `rm -rf build`? (y/n)").
//
// We capture exactly one value per node — its latest meaningful clean output
// line + a timestamp — at the SAME existing chokepoint that already ANSI-strips
// every chunk to feed the status classifier (TerminalOverlay.flushClassify). No
// new IPC, no second parse pass, no ring buffer, no persistence.
//
// IMPORTANT — persistence contract: this state lives ONLY in memory, exactly
// like mission.ts and relay.ts. It is NEVER added to canvas.ts loadLayout /
// App.tsx serialization, so it cannot affect persistence or cold-start
// behavior. A fresh / restored canvas always starts with no excerpts.

import { create } from 'zustand'

/** The latest meaningful output line captured for a single node. */
export interface LensLine {
  /** the cleaned, length-capped excerpt text. */
  text: string
  /** wall-clock ms when it was captured. */
  ts: number
}

interface LensState {
  /** per-nodeId latest meaningful line. A single value, not a ring buffer. */
  lines: Record<string, LensLine>
  /** Set (overwrite) the latest line for a node. ts auto-filled. */
  set: (nodeId: string, text: string) => void
  /** Drop the excerpt for one node (call on terminal disposal). */
  clearForNode: (nodeId: string) => void
  /** Wipe every excerpt (call on new_canvas / clear). */
  clearAll: () => void
}

export const useLens = create<LensState>((set) => ({
  lines: {},

  set: (nodeId, text) =>
    set((s) =>
      s.lines[nodeId]?.text === text
        ? {}
        : { lines: { ...s.lines, [nodeId]: { text, ts: Date.now() } } }
    ),

  clearForNode: (nodeId) =>
    set((s) => {
      if (!(nodeId in s.lines)) return {}
      const { [nodeId]: _drop, ...rest } = s.lines
      return { lines: rest }
    }),

  clearAll: () => set({ lines: {} })
}))
