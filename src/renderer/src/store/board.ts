// board.ts
//
// Brief Board — the SHARED agent context pool. A tiny in-memory store of "pinned
// facts": short, durable, attributed snippets an agent discovered ("Atlas:
// API base is /v2, auth is bearer token"). Facts are pinned in one click from a
// node's live Agent Lens excerpt, or typed by hand, then injected as a compact
// context block into any agent via the SAME proven pendingPrompt / pty.write
// delivery path used by spawn tasks and Agent Relay.
//
// This is the missing connective tissue: every other intelligence surface is
// one-way OBSERVABILITY (Mission Pulse, Agent Lens, Thermal/Radar, Director/
// Replay) or STATIC orchestration (Agent Relay carries pre-typed text). The
// Brief Board is the first surface that lets an agent's actual discoveries flow
// to another agent — shared context that agents read and write, on the canvas.
//
// IMPORTANT — persistence contract: this state lives ONLY in memory, exactly
// like mission.ts / relay.ts / lens.ts. It is NEVER added to canvas.ts loadLayout
// / App.tsx serialization and NEVER sent over IPC, so it cannot affect
// persistence or cold-start behavior. A fresh / restored canvas always starts
// with an empty board. board.ts imports NOTHING from canvas.ts, so the
// one-directional import contract (canvas may lazily getState() this store on
// reset) introduces no cycle.

import { create } from 'zustand'
import { nanoid } from 'nanoid'

/** A single pinned, attributed fact in the shared context pool. */
export interface BoardFact {
  id: string
  /** wall-clock ms when it was pinned. */
  ts: number
  /** the durable snippet (capped, see MAX_TEXT). */
  text: string
  /** node id this fact was pinned from (for provenance / per-node clearing). */
  sourceNodeId?: string
  /** the node title at pin time (kept even after the node closes). */
  sourceTitle?: string
  /** the agent persona at pin time, for the attribution chip. */
  agent?: string
  /**
   * Provenance: true when the Insight Harvester auto-pinned this from an agent's
   * output (vs. a human clicking pin / typing it). Purely a display flag — the
   * BriefBoard panel renders a small badge for it; no behavior depends on it.
   */
  harvested?: boolean
}

/** Hard caps so the board stays a compact, demo-able pool, never unbounded. */
const MAX_TEXT = 200
/** Ring buffer: keep only the most recent MAX_FACTS facts. */
const MAX_FACTS = 24

interface BoardState {
  facts: BoardFact[]
  /**
   * Pin a fact. Trims + caps the text, skips a back-to-back duplicate of the
   * most-recent fact's text, and keeps the board to MAX_FACTS (dropping the
   * oldest). Returns the new fact id, or null if rejected (empty/duplicate).
   */
  pin: (f: {
    text: string
    sourceNodeId?: string
    sourceTitle?: string
    agent?: string
    harvested?: boolean
  }) => string | null
  /** Remove a single fact by id. */
  remove: (id: string) => void
  /** Drop every fact pinned from this node (call on terminal disposal). */
  clearForNode: (nodeId: string) => void
  /** Wipe the whole board (call on new_canvas / clear / load). */
  clearAll: () => void
}

export const useBoard = create<BoardState>((set, get) => ({
  facts: [],

  pin: ({ text, sourceNodeId, sourceTitle, agent, harvested }) => {
    let body = (text || '').replace(/\s+/g, ' ').trim()
    if (!body) return null
    if (body.length > MAX_TEXT) body = body.slice(0, MAX_TEXT - 1) + '…'
    // Skip a back-to-back duplicate so clicking pin twice on the same Lens line
    // (which doesn't change between frames) never stacks identical facts. This
    // also bounds the autonomous harvester for free: a line that doesn't change
    // between flushes can't stack, and the ring buffer caps total facts.
    const last = get().facts[get().facts.length - 1]
    if (last && last.text === body) return null
    const id = nanoid(8)
    const fact: BoardFact = { id, ts: Date.now(), text: body, sourceNodeId, sourceTitle, agent, harvested }
    set((s) => {
      const next = [...s.facts, fact]
      return { facts: next.length > MAX_FACTS ? next.slice(-MAX_FACTS) : next }
    })
    return id
  },

  remove: (id) => set((s) => ({ facts: s.facts.filter((f) => f.id !== id) })),

  clearForNode: (nodeId) =>
    set((s) => {
      if (!s.facts.some((f) => f.sourceNodeId === nodeId)) return {}
      return { facts: s.facts.filter((f) => f.sourceNodeId !== nodeId) }
    }),

  clearAll: () => set({ facts: [] })
}))
