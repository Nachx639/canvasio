// tripwire.ts
//
// Tripwire — content-triggered output alerts with one-key jump.
//
// Every observability surface in CanvasIO is either passive (Watchtower / Agent
// Lens show the latest line; Pulse Radar / Director show STATE), retrospective
// (Echo Index searches output AFTER it scrolled), or status-driven (Stall Watch
// fires only on `waiting` / `error`). NONE let the operator say, ahead of time,
// "yank me to whichever agent prints THIS" — a dev URL, "tests passed",
// "migration complete", "Allow `rm -rf`", an exception class, or any regex.
//
// Tripwire is a keyboard-first watch list of user-defined output patterns
// (plain substring or `/regex/`). Each meaningful, ANSI-stripped output line —
// the exact `line` the Echo chokepoint already produces per node — is matched
// against every ARMED wire. On a hit it records a TripwireHit (surfaced by
// TripwireToast + the panel feed) and the operator can fly to the firing node
// with one keypress via the existing centerOnNode.
//
// IMPORTANT — persistence contract (verbatim from echo.ts / lens.ts):
//   This state lives ONLY in memory. It is NEVER added to canvas.ts loadLayout /
//   App.tsx serialization, NEVER sent over IPC. A fresh / restored canvas always
//   starts with no wires and no hits. Navigation is CAMERA-ONLY: a hit resolves
//   to a nodeId and the UI flies via the existing centerOnNode (full Slipstream
//   Back/Forward + Wayback inherited). No SNAPSHOT/geometry is ever mutated here.
//
// One-directional imports only (tripwire -> canvas for the reset registry +
// deferred getState; canvas never imports tripwire — it reaches this module
// lazily through registerTripwireReset, exactly like stall.ts).

import { create } from 'zustand'
import { useCanvas, registerTripwireReset } from './canvas'
import { compileTripwire, matches, type CompiledTripwire } from '../lib/tripwireMatch'

/** Max retained hits (oldest-first eviction), mirroring ECHO_MAX discipline. */
export const TRIPWIRE_MAX_HITS = 50

/** One user-defined watch pattern. */
export interface Tripwire {
  id: string
  /** the raw pattern text the user typed (plain or `/regex/flags`). */
  pattern: string
  /** compiled matcher (never serialized; rebuilt on add). */
  compiled: CompiledTripwire
  /** when false the wire is dormant and scan() skips it. */
  armed: boolean
  /** when true the wire disarms itself after its first hit. */
  once: boolean
  /** optional human label shown in the panel (falls back to the pattern). */
  label?: string
  createdTs: number
}

/** One recorded match: which wire fired on which node's line, and when. */
export interface TripwireHit {
  id: string
  wireId: string
  nodeId: string
  /** denormalized node title at hit time (the node may later be gone). */
  title: string
  /** denormalized agent kind at hit time (for the glyph/accent). */
  agent?: string
  /** the matched output line. */
  line: string
  ts: number
  /** false until the operator has seen/visited this hit. */
  seen: boolean
}

interface TripwireState {
  wires: Tripwire[]
  hits: TripwireHit[]

  /** Add a wire from a raw pattern (compiled here). No-op on an empty pattern. */
  add: (pattern: string, opts?: { label?: string; once?: boolean }) => void
  /** Remove a wire by id. */
  remove: (id: string) => void
  /** Toggle a wire armed/disarmed. */
  toggleArm: (id: string) => void
  /** Toggle a wire's once-vs-repeat behavior. */
  toggleOnce: (id: string) => void
  /** Drop all wires (keeps the hit feed). */
  clearWires: () => void

  /**
   * THE HOT PATH. Match one meaningful output line for `nodeId` against every
   * ARMED wire; record a hit per match (denormalizing title/agent from the live
   * canvas at call-time only) and disarm any `once` wire that fired. Cheap and
   * total — a no-op when there are no armed wires, so an idle canvas costs ~one
   * array length check per line. Fire-and-forget; never throws into the caller.
   */
  scan: (nodeId: string, line: string) => void

  /** Mark a single hit seen. */
  markSeen: (hitId: string) => void
  /** Mark every hit seen. */
  markAllSeen: () => void
  /** The newest hit not yet seen (for ⇧W jump / the toast), or null. */
  newestUnseen: () => TripwireHit | null

  /** Drop hits sourced from one node (call on terminal disposal). */
  clearForNode: (nodeId: string) => void
  /** Wipe wires + hits (call on new_canvas / clear). */
  clearAll: () => void
}

let seq = 0
const nextId = (): string => `tw${Date.now().toString(36)}${(seq++).toString(36)}`

export const useTripwire = create<TripwireState>((set, get) => ({
  wires: [],
  hits: [],

  add: (pattern, opts) => {
    const raw = (pattern ?? '').trim()
    if (!raw) return
    const wire: Tripwire = {
      id: nextId(),
      pattern: raw,
      compiled: compileTripwire(raw),
      armed: true,
      once: opts?.once ?? false,
      label: opts?.label?.trim() || undefined,
      createdTs: Date.now()
    }
    set((s) => ({ wires: [...s.wires, wire] }))
  },

  remove: (id) => set((s) => ({ wires: s.wires.filter((w) => w.id !== id) })),

  toggleArm: (id) =>
    set((s) => ({
      wires: s.wires.map((w) => (w.id === id ? { ...w, armed: !w.armed } : w))
    })),

  toggleOnce: (id) =>
    set((s) => ({
      wires: s.wires.map((w) => (w.id === id ? { ...w, once: !w.once } : w))
    })),

  clearWires: () => set({ wires: [] }),

  scan: (nodeId, line) => {
    const wires = get().wires
    if (wires.length === 0 || !line) return
    let fired: Tripwire[] | null = null
    for (const w of wires) {
      if (!w.armed) continue
      try {
        if (matches(w.compiled, line)) (fired ??= []).push(w)
      } catch {
        /* a matcher must never break the terminal scan path */
      }
    }
    if (!fired) return

    // Denormalize title/agent from the live canvas at call-time only (deferred
    // getState — same pattern echo/changeset use; never imported reactively).
    const node = useCanvas.getState().nodes.find((n) => n.id === nodeId)
    const title = (node?.title || 'Agente').trim()
    const agent = node?.agent
    const ts = Date.now()

    set((s) => {
      const newHits: TripwireHit[] = fired!.map((w) => ({
        id: nextId(),
        wireId: w.id,
        nodeId,
        title,
        agent,
        line,
        ts,
        seen: false
      }))
      const merged = [...s.hits, ...newHits]
      // Cap as a ring (oldest-first), mirroring ECHO_MAX.
      const hits =
        merged.length > TRIPWIRE_MAX_HITS ? merged.slice(-TRIPWIRE_MAX_HITS) : merged
      // Disarm any `once` wire that fired this pass.
      const firedOnceIds = new Set(fired!.filter((w) => w.once).map((w) => w.id))
      const wires =
        firedOnceIds.size === 0
          ? s.wires
          : s.wires.map((w) => (firedOnceIds.has(w.id) ? { ...w, armed: false } : w))
      return { hits, wires }
    })
  },

  markSeen: (hitId) =>
    set((s) => ({
      hits: s.hits.map((h) => (h.id === hitId ? { ...h, seen: true } : h))
    })),

  markAllSeen: () =>
    set((s) => ({
      hits: s.hits.some((h) => !h.seen)
        ? s.hits.map((h) => (h.seen ? h : { ...h, seen: true }))
        : s.hits
    })),

  newestUnseen: () => {
    const hits = get().hits
    for (let i = hits.length - 1; i >= 0; i--) {
      if (!hits[i].seen) return hits[i]
    }
    return null
  },

  clearForNode: (nodeId) =>
    set((s) => {
      if (!s.hits.some((h) => h.nodeId === nodeId)) return {}
      return { hits: s.hits.filter((h) => h.nodeId !== nodeId) }
    }),

  clearAll: () => set({ wires: [], hits: [] })
}))

// Register the full-reset hook so new_canvas / loadLayout / bootRecipe wipe all
// wires + hits (orphan cleanup), alongside the other in-memory stores. Reached
// lazily through canvas.ts's registry to keep the one-directional-import
// contract (tripwire.ts imports canvas.ts, never the reverse) — exactly the
// pattern stall.ts uses via registerStallReset.
registerTripwireReset(() => {
  useTripwire.getState().clearAll()
})
