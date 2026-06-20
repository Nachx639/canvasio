// recall.ts
//
// Recall — Cross-Mission Agent Memory. The first and ONLY persisted intelligence
// surface in CanvasIO. Every other store (board, mission, lens, consensus,
// objectives, conductor, horizon) is explicitly in-memory-only: nothing about
// what your agents LEARNED survives a relaunch or a New Canvas. Recall is the
// missing long-term memory — a small, bounded knowledge base of durable facts
// that an agent (or a human) deemed worth REMEMBERING. When a fact is corroborated
// across agents (the existing Consensus signal) or a human explicitly promotes it
// from the Brief Board, it is "remembered" into here. On a fresh mission, the
// moment an agent spawns, the matched subset is silently surfaced and injected as
// a "Lo que ya sabemos" context block through the SAME readiness-gated pty.write
// path the Brief Board and Agent Relay already use.
//
// PERSISTENCE CONTRACT — the inversion of every other store:
//   * Recall persists to its OWN localStorage key 'canvasio:recall', mirroring the
//     theme/volume pattern at canvas.ts:1036 — load lazily, write synchronously
//     on each mutation inside try/catch (the same defensive pattern App.tsx uses).
//   * It is NEVER added to canvasio:layout / App.tsx canvas serialization, NEVER sent
//     over IPC, and deliberately NOT registered into resetRelayAndMission(): New
//     Canvas wipes the live board but Recall PERSISTS. clearAll() is the only way
//     to forget remembered facts.
//   * recall.ts imports NOTHING from canvas.ts (no cycle); the relevance matcher
//     and injection formatter live in the PURE lib/recallMatch.ts.
//
// Shape reuses the BoardFact-ish fields (text, subject, value, agent, sourceTitle,
// ts) plus a 'hits' counter: re-remembering an already-known fact bumps hits and
// freshens it instead of duplicating, so the store stays a compact, deduped pool.

import { create } from 'zustand'
import { nanoid } from 'nanoid'

/** A single durable, remembered fact in the long-term knowledge base. */
export interface RecallFact {
  id: string
  /** wall-clock ms when first remembered (refreshed when re-remembered). */
  ts: number
  /** the durable snippet (capped, see MAX_TEXT). */
  text: string
  /** normalized subject key (consensus.subjectKey) when known — for dedup + match. */
  subject?: string
  /** normalized asserted value (consensus.assertedValue) when known — for dedup. */
  value?: string
  /** the agent / source title at remember time, kept for provenance. */
  agent?: string
  /** the node title at remember time (for the "pin back to board" provenance). */
  sourceTitle?: string
  /**
   * How many times this fact has been (re-)remembered. Bumped instead of
   * duplicating when the same subject+value (or same text) is remembered again —
   * a soft confidence signal surfaced as a tiny badge in the RecallPanel.
   */
  hits: number
}

/** The localStorage key. Its OWN key, untouched by canvasio:layout serialization. */
const STORAGE_KEY = 'canvasio:recall'
/** Hard caps so the knowledge base stays a compact, demo-able pool. */
const MAX_TEXT = 200
/** Bounded ring: keep only the most recent MAX_FACTS remembered facts. */
const MAX_FACTS = 40

/** Collapse internal whitespace and trim. */
function squash(s: string): string {
  return (s || '').replace(/\s+/g, ' ').trim()
}

/** Load the persisted facts. Defensive: any malformed/blocked storage -> []. */
function load(): RecallFact[] {
  try {
    if (typeof localStorage === 'undefined') return []
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    const out: RecallFact[] = []
    for (const item of parsed) {
      if (!item || typeof item !== 'object') continue
      const f = item as Partial<RecallFact>
      const text = squash(typeof f.text === 'string' ? f.text : '')
      if (!text) continue
      out.push({
        id: typeof f.id === 'string' && f.id ? f.id : nanoid(8),
        ts: typeof f.ts === 'number' && Number.isFinite(f.ts) ? f.ts : Date.now(),
        text: text.length > MAX_TEXT ? text.slice(0, MAX_TEXT - 1) + '…' : text,
        subject: typeof f.subject === 'string' ? f.subject : undefined,
        value: typeof f.value === 'string' ? f.value : undefined,
        agent: typeof f.agent === 'string' ? f.agent : undefined,
        sourceTitle: typeof f.sourceTitle === 'string' ? f.sourceTitle : undefined,
        hits: typeof f.hits === 'number' && f.hits > 0 ? Math.floor(f.hits) : 1
      })
    }
    return out.length > MAX_FACTS ? out.slice(-MAX_FACTS) : out
  } catch {
    return []
  }
}

/** Persist the facts synchronously. Defensive: quota/blocked storage is ignored. */
function save(facts: RecallFact[]): void {
  try {
    if (typeof localStorage === 'undefined') return
    localStorage.setItem(STORAGE_KEY, JSON.stringify(facts))
  } catch {
    /* ignore quota/blocked storage — Recall must never throw into a caller */
  }
}

interface RecallState {
  facts: RecallFact[]
  /**
   * Remember a fact. Dedups by subject+value (when both known) else by exact
   * text: a hit on an existing fact bumps its `hits` and freshens its ts instead
   * of duplicating. Trims + caps the text and keeps the base to MAX_FACTS. Returns
   * the fact id (existing or new), or null if rejected (empty text).
   */
  remember: (f: {
    text: string
    subject?: string
    value?: string
    agent?: string
    sourceTitle?: string
  }) => string | null
  /** Forget a single remembered fact by id. */
  forget: (id: string) => void
  /** Wipe the entire knowledge base (the only way to clear persisted memory). */
  clearAll: () => void
}

export const useRecall = create<RecallState>((set, get) => ({
  // Lazily loaded ONCE at store creation (first import), mirroring how canvas.ts
  // seeds theme/volume from localStorage at store init.
  facts: load(),

  remember: ({ text, subject, value, agent, sourceTitle }) => {
    let body = squash(text)
    if (!body) return null
    if (body.length > MAX_TEXT) body = body.slice(0, MAX_TEXT - 1) + '…'
    const subj = subject ? squash(subject) : undefined
    const val = value ? squash(value) : undefined

    const existing = get().facts.find((f) => {
      // Strong dedup: same subject AND same value is the SAME claim.
      if (subj && val && f.subject === subj && f.value === val) return true
      // Fallback dedup: identical text (case-insensitive) is the same fact.
      return f.text.toLowerCase() === body.toLowerCase()
    })

    if (existing) {
      // Bump confidence + freshen instead of duplicating. Keep the richer
      // attribution if the new occurrence carries one and the old one didn't.
      const id = existing.id
      set((s) => ({
        facts: s.facts.map((f) =>
          f.id === id
            ? {
                ...f,
                hits: f.hits + 1,
                ts: Date.now(),
                agent: f.agent || agent,
                sourceTitle: f.sourceTitle || sourceTitle,
                subject: f.subject ?? subj,
                value: f.value ?? val
              }
            : f
        )
      }))
      save(get().facts)
      return id
    }

    const id = nanoid(8)
    const fact: RecallFact = {
      id,
      ts: Date.now(),
      text: body,
      subject: subj,
      value: val,
      agent: agent ? squash(agent) : undefined,
      sourceTitle: sourceTitle ? squash(sourceTitle) : undefined,
      hits: 1
    }
    set((s) => {
      const next = [...s.facts, fact]
      return { facts: next.length > MAX_FACTS ? next.slice(-MAX_FACTS) : next }
    })
    save(get().facts)
    return id
  },

  forget: (id) => {
    set((s) => ({ facts: s.facts.filter((f) => f.id !== id) }))
    save(get().facts)
  },

  clearAll: () => {
    set({ facts: [] })
    save([])
  }
}))
