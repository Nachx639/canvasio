// commandTrail.ts (store)
//
// Command Trail — per-agent executed-command audit timeline. A memory-only
// zustand store holding, per nodeId, a small capped ring of the shell commands an
// agent actually RAN (detected at the same flush chokepoint that feeds Lens/Echo/
// Tripwire), each with a timestamp and a RISK tag. A cross-agent recent() selector
// powers the unified timeline panel; hasDestructive(nodeId) powers the ⚠ chip.
//
// IMPORTANT — persistence contract: this state lives ONLY in memory, exactly like
// echo.ts / lens.ts / mission.ts / relay.ts. It is NEVER added to canvas.ts
// loadLayout / App.tsx serialization, so it cannot affect persistence or
// cold-start behavior. A fresh / restored canvas always starts with no commands.
// Nothing here mutates geometry; the panel re-runs commands only through the
// existing pty.write bridge (no new IPC, no main-process change).

import { create } from 'zustand'
import type { CommandRisk } from '../lib/commandTrail'

/** Max commands retained per node (oldest-first eviction). */
export const CMDTRAIL_MAX = 40

/** One recognized command an agent ran, for a single node. */
export interface TrailEntry {
  /** stable id for keys / re-run targeting (ts + counter, monotonic). */
  id: string
  /** the command text as it ran. */
  cmd: string
  /** the risk class assigned by the classifier. */
  risk: CommandRisk
  /** wall-clock ms when it was captured. */
  ts: number
}

/** A cross-agent timeline row: a command plus its source node. */
export interface TrailHit extends TrailEntry {
  nodeId: string
}

let seq = 0

interface CommandTrailState {
  /** per-nodeId capped ring of detected commands (a ring buffer, not one value). */
  entries: Record<string, TrailEntry[]>
  /**
   * Append a recognized command for a node. Deduped against that node's last
   * identical command (a redraw can re-emit the same prompt line) and capped to
   * CMDTRAIL_MAX, oldest-first. id + ts auto-filled.
   */
  push: (nodeId: string, cmd: string, risk: CommandRisk) => void
  /** Drop the ring for one node (call on terminal disposal). */
  clearForNode: (nodeId: string) => void
  /** Wipe every ring (call on new_canvas / clear). */
  clearAll: () => void
  /**
   * Newest-first flattened timeline across ALL nodes, optionally filtered by a
   * risk class and/or a single nodeId. Pure / read-only.
   */
  recent: (opts?: { risk?: CommandRisk; nodeId?: string; limit?: number }) => TrailHit[]
  /** Has this node ever run a command tagged `destructive`? (powers the ⚠ chip). */
  hasDestructive: (nodeId: string) => boolean
}

export const useCommandTrail = create<CommandTrailState>((set, get) => ({
  entries: {},

  push: (nodeId, cmd, risk) =>
    set((s) => {
      const text = (cmd ?? '').trim()
      if (!text) return {}
      const ring = s.entries[nodeId]
      // Dedupe against the last identical command (redraws re-emit prompt lines).
      if (ring && ring.length > 0 && ring[ring.length - 1].cmd === text) return {}
      const entry: TrailEntry = {
        id: `${Date.now()}-${seq++}`,
        cmd: text,
        risk,
        ts: Date.now()
      }
      const next = [...(ring ?? []), entry]
      // Cap to the most recent CMDTRAIL_MAX, dropping oldest-first.
      const capped = next.length > CMDTRAIL_MAX ? next.slice(-CMDTRAIL_MAX) : next
      return { entries: { ...s.entries, [nodeId]: capped } }
    }),

  clearForNode: (nodeId) =>
    set((s) => {
      if (!(nodeId in s.entries)) return {}
      const { [nodeId]: _drop, ...rest } = s.entries
      return { entries: rest }
    }),

  clearAll: () => set({ entries: {} }),

  recent: (opts) => {
    const { risk, nodeId, limit = 200 } = opts ?? {}
    const { entries } = get()
    const out: TrailHit[] = []
    for (const id in entries) {
      if (nodeId && id !== nodeId) continue
      for (const e of entries[id]) {
        if (risk && e.risk !== risk) continue
        out.push({ ...e, nodeId: id })
      }
    }
    out.sort((a, b) => b.ts - a.ts)
    return out.slice(0, limit)
  },

  hasDestructive: (nodeId) => {
    const ring = get().entries[nodeId]
    if (!ring) return false
    for (const e of ring) if (e.risk === 'destructive') return true
    return false
  }
}))
