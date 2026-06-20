// questions.ts
//
// Open Questions — the in-memory store of live "an agent is BLOCKED on this"
// cards. It is the inverse of the Brief Board (board.ts): the board pools what
// agents KNOW; this pools what they DON'T. When the pure detector
// (lib/openQuestion.detectQuestion) fires at the SAME meaningful-line chokepoint
// the Insight Harvester uses, the caller (TerminalOverlay) pushes a card here,
// attributed to the asking node. The QuestionsPanel then matches it against the
// board's facts + sibling agents' lens excerpts and offers a one-click answer.
//
// PERSISTENCE CONTRACT (mirrors mission.ts / board.ts / lens.ts EXACTLY): this
// state lives ONLY in memory. It is NEVER added to canvas.ts loadLayout /
// App.tsx serialization and NEVER sent over IPC, so it cannot affect persistence
// or cold-start behavior. A fresh / restored canvas always starts with no open
// questions. This module imports NOTHING from canvas.ts; canvas.ts may lazily
// getState() it on reset (one-directional, no cycle), like the board.

import { create } from 'zustand'
import { nanoid } from 'nanoid'

/** A single live, attributed open question. */
export interface OpenQuestion {
  id: string
  /** wall-clock ms when the question was detected. */
  ts: number
  /** the cleaned, capped question text. */
  text: string
  /** consensus subjectKey() of the text, or null when none applies (then it can
   *  only be flagged to the human — never auto-matched). */
  subject: string | null
  /** node id of the agent that asked (for provenance / per-node clearing). */
  askingNodeId: string
  /** the asking node's title at detect time (kept even after the node closes). */
  askingTitle: string
  /** true once answered/flagged/dismissed/auto-resolved — kept briefly for UI. */
  resolved: boolean
}

/** Hard caps so the bus stays a compact, demo-able pool, never unbounded. */
const MAX_TEXT = 200
/** Ring buffer: keep only the most recent MAX_QUESTIONS cards. */
const MAX_QUESTIONS = 24

interface QuestionsState {
  questions: OpenQuestion[]
  /**
   * Add an open question. Trims + caps the text, skips a back-to-back duplicate
   * of the SAME node's most-recent UNRESOLVED question (so a redrawn prompt line
   * can't stack), and keeps the bus to MAX_QUESTIONS (dropping the oldest).
   * Returns the new id, or null if rejected (empty/duplicate).
   */
  add: (q: {
    text: string
    subject: string | null
    askingNodeId: string
    askingTitle: string
  }) => string | null
  /** Mark one card resolved (answered / flagged / dismissed) by id. */
  resolve: (id: string) => void
  /** Remove one card entirely by id. */
  remove: (id: string) => void
  /**
   * Auto-resolve every UNRESOLVED question asked by this node — call when the
   * node reports a fresh work-start (it moved on, the question is stale). Distinct
   * from clearForNode, which removes the cards outright on disposal.
   */
  resolveForNode: (nodeId: string) => void
  /** Drop every card asked by this node (call on terminal disposal). */
  clearForNode: (nodeId: string) => void
  /** Wipe the whole bus (call on new_canvas / clear / load). */
  clearAll: () => void
}

export const useQuestions = create<QuestionsState>((set, get) => ({
  questions: [],

  add: ({ text, subject, askingNodeId, askingTitle }) => {
    let body = (text || '').replace(/\s+/g, ' ').trim()
    if (!body) return null
    if (body.length > MAX_TEXT) body = body.slice(0, MAX_TEXT - 1) + '…'
    // Skip a back-to-back duplicate from the SAME node while still unresolved, so
    // a question line redrawn between flushes never stacks identical cards.
    const dup = get().questions.find(
      (q) => !q.resolved && q.askingNodeId === askingNodeId && q.text === body
    )
    if (dup) return null
    const id = nanoid(8)
    const card: OpenQuestion = {
      id,
      ts: Date.now(),
      text: body,
      subject,
      askingNodeId,
      askingTitle,
      resolved: false
    }
    set((s) => {
      const next = [...s.questions, card]
      return { questions: next.length > MAX_QUESTIONS ? next.slice(-MAX_QUESTIONS) : next }
    })
    return id
  },

  resolve: (id) =>
    set((s) => {
      if (!s.questions.some((q) => q.id === id && !q.resolved)) return {}
      return { questions: s.questions.map((q) => (q.id === id ? { ...q, resolved: true } : q)) }
    }),

  remove: (id) => set((s) => ({ questions: s.questions.filter((q) => q.id !== id) })),

  resolveForNode: (nodeId) =>
    set((s) => {
      if (!s.questions.some((q) => q.askingNodeId === nodeId && !q.resolved)) return {}
      return {
        questions: s.questions.map((q) =>
          q.askingNodeId === nodeId && !q.resolved ? { ...q, resolved: true } : q
        )
      }
    }),

  clearForNode: (nodeId) =>
    set((s) => {
      if (!s.questions.some((q) => q.askingNodeId === nodeId)) return {}
      return { questions: s.questions.filter((q) => q.askingNodeId !== nodeId) }
    }),

  clearAll: () => set({ questions: [] })
}))
