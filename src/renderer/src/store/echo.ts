// echo.ts
//
// Echo Index — Spatial Grep Across Every Agent's Output.
//
// Every spatial-nav surface in CanvasIO answers "take me to a NODE" (Beacon,
// Atlas, JumpHints, Waypoints, Slipstream). NONE answer the question you ask all
// day: "WHERE did that line scroll past?" — "which terminal printed
// `error TS2304`?", "who asked `Allow rm -rf? (y/n)`?", "where did the dev URL
// appear?". The Agent Lens captures clean output but deliberately keeps only ONE
// latest line per node ("a single value, not a ring buffer" — lens.ts), so the
// moment a line scrolls it is gone forever and unsearchable.
//
// Echo Index makes the canvas content-addressable. It taps the SAME existing
// chokepoint that already ANSI-strips every chunk to feed the status classifier
// (TerminalOverlay.flushClassify) and, instead of keeping only the last line,
// APPENDS each meaningful line into a small capped ring per node (~60 lines,
// dropped oldest-first). A `search()` selector then turns "scroll-blind"
// multi-agent output into a searchable spatial index — with zero new parse pass.
//
// IMPORTANT — persistence contract: this state lives ONLY in memory, exactly
// like lens.ts / mission.ts / relay.ts. It is NEVER added to canvas.ts
// loadLayout / App.tsx serialization, so it cannot affect persistence or
// cold-start behavior. A fresh / restored canvas always starts with no lines.
// Navigation is CAMERA-ONLY: hits resolve to a nodeId and the palette flies via
// the existing centerOnNode (full Slipstream Back/Forward + Wayback inherited).
// No SNAPSHOT/geometry is ever mutated from here.

import { create } from 'zustand'

/** Max meaningful lines retained per node (oldest-first eviction). */
export const ECHO_MAX = 60

/** One captured meaningful output line for a single node. */
export interface EchoLine {
  /** the cleaned, length-capped excerpt text. */
  text: string
  /** wall-clock ms when it was captured. */
  ts: number
}

/** A ranked search hit: the matched line plus its source node. */
export interface EchoHit {
  nodeId: string
  text: string
  ts: number
}

interface EchoState {
  /** per-nodeId capped ring of meaningful lines (a ring buffer, not one value). */
  entries: Record<string, EchoLine[]>
  /**
   * Append a meaningful line for a node. Deduped against that node's last
   * identical line (same guard lens.set uses) and capped to ECHO_MAX,
   * oldest-first. ts auto-filled.
   */
  push: (nodeId: string, text: string) => void
  /** Drop the ring for one node (call on terminal disposal). */
  clearForNode: (nodeId: string) => void
  /** Wipe every ring (call on new_canvas / clear). */
  clearAll: () => void
  /**
   * Rank meaningful lines across ALL nodes by a query (case-insensitive
   * substring). Scoring spirit mirrors CommandPalette.rank: prefix > word-start
   * > substring, nudged by recency and short-line tightness. Returns up to
   * `limit` hits, best first. Pure / read-only.
   */
  search: (query: string, limit?: number) => EchoHit[]
}

export const useEcho = create<EchoState>((set, get) => ({
  entries: {},

  push: (nodeId, text) =>
    set((s) => {
      const ring = s.entries[nodeId]
      // Dedupe against the last identical line (same guard lens.ts uses).
      if (ring && ring.length > 0 && ring[ring.length - 1].text === text) return {}
      const next = [...(ring ?? []), { text, ts: Date.now() }]
      // Cap to the most recent ECHO_MAX, dropping oldest-first.
      const capped = next.length > ECHO_MAX ? next.slice(-ECHO_MAX) : next
      return { entries: { ...s.entries, [nodeId]: capped } }
    }),

  clearForNode: (nodeId) =>
    set((s) => {
      if (!(nodeId in s.entries)) return {}
      const { [nodeId]: _drop, ...rest } = s.entries
      return { entries: rest }
    }),

  clearAll: () => set({ entries: {} }),

  search: (query, limit = 40) => {
    const q = query.trim().toLowerCase()
    if (!q) return []
    const now = Date.now()
    const scored: { hit: EchoHit; score: number }[] = []
    const { entries } = get()
    for (const nodeId in entries) {
      const ring = entries[nodeId]
      for (const line of ring) {
        const t = line.text.toLowerCase()
        const idx = t.indexOf(q)
        if (idx < 0) continue
        // Base match quality: prefix > word-start > substring.
        let score: number
        if (idx === 0) score = 100
        else if (/\s/.test(t[idx - 1] ?? '')) score = 80
        else score = 60
        // Recency nudge: newer lines float up (up to +15 within ~5 min).
        const ageMin = (now - line.ts) / 60000
        score += Math.max(0, 15 - ageMin * 3)
        // Tightness nudge: shorter lines (closer to the match) rank slightly higher.
        score -= line.text.length * 0.02
        scored.push({ hit: { nodeId, text: line.text, ts: line.ts }, score })
      }
    }
    scored.sort((a, b) => b.score - a.score)
    return scored.slice(0, limit).map((s) => s.hit)
  }
}))
