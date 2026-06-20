// courseCorrect.ts (store glue)
//
// Course Correct — store glue for the live knowledge-driven agent whisper
// (lib/courseCorrect.ts). This is a TINY zustand store that holds NOTHING
// persistent (IN-MEMORY ONLY, never added to canvas.ts loadLayout / serialization /
// resetRelayAndMission — the exact same contract as conductor.ts / mission.ts). Its
// only persistent piece of state is a transient `sent` id set so the same
// correction is never offered twice in a session; it is wiped only by explicit
// in-process flow, never serialized, never sent over IPC.
//
// It exists only to:
//   1) getCorrections() — lazily read useBoard / useCanvas at CALL TIME ONLY (never
//      at module init), run analyzeConsensus over the live board facts, assemble the
//      pure CourseCorrectInput, and return computeCourseCorrections(...), minus any
//      already-sent ids.
//   2) whisper(correction) — dispatch the polite Spanish note to the drifting agent
//      via the EXISTING readiness-gated drain: useRelay.getState().enqueueForTarget
//      (the same path "Inject Board" / Smart Relay already trust). Records the
//      correction id as 'sent' so it isn't offered again.
//
// CALL-TIME-ONLY DISCIPLINE: like conductor.getRecommendations() and
// relay.criticalPath(), every cross-store read happens INSIDE the method, never at
// module init, so the ES-module import graph has no initialization-order hazard.

import { create } from 'zustand'
import { useBoard } from './board'
import { useCanvas } from './canvas'
import { useRelay } from './relay'
import { analyzeConsensus } from '../lib/consensus'
import {
  computeCourseCorrections,
  type CourseCorrection,
  type CourseCorrectInput,
  type LiveNode
} from '../lib/courseCorrect'

interface CourseCorrectState {
  /** ids of corrections already whispered this session (one-shot guard). */
  sent: Set<string>
  /**
   * Lazily assemble the pure CourseCorrectInput from the live Brief Board + canvas
   * and return the corrections the operator can still act on (already-sent ones are
   * filtered out). Reads useBoard / useCanvas via getState() INSIDE the call only,
   * keeping the call-time-only import discipline. Pure downstream: it never mutates
   * anything. Defensive — any unavailable store degrades to an empty result.
   */
  getCorrections: () => CourseCorrection[]
  /**
   * Whisper ONE correction to its drifting agent via the EXISTING readiness-gated
   * relay drain (enqueueForTarget). Records the id as sent so it isn't offered
   * twice. Returns true when the note was enqueued.
   */
  whisper: (c: CourseCorrection) => boolean
}

export const useCourseCorrect = create<CourseCorrectState>((set, get) => ({
  sent: new Set<string>(),

  getCorrections: () => {
    let facts: { id: string; sourceNodeId?: string }[] = []
    let liveNodes: LiveNode[] = []
    try {
      facts = useBoard.getState().facts.map((f) => ({ id: f.id, sourceNodeId: f.sourceNodeId }))
    } catch {
      facts = []
    }
    try {
      liveNodes = useCanvas
        .getState()
        .nodes.filter((n) => n.kind === 'terminal')
        .map((n) => ({ id: n.id, title: n.title, status: n.status }))
    } catch {
      liveNodes = []
    }

    // analyzeConsensus needs the full BoardFact shape (text + attribution); read the
    // raw facts again for it (cheap, in-memory) rather than threading two shapes.
    let conflicts: CourseCorrectInput['conflicts'] = []
    try {
      conflicts = analyzeConsensus(useBoard.getState().facts).conflicts
    } catch {
      conflicts = []
    }
    if (!conflicts.length) return []

    const all = computeCourseCorrections({ conflicts, facts, liveNodes })
    const sent = get().sent
    return sent.size ? all.filter((c) => !sent.has(c.id)) : all
  },

  whisper: (c) => {
    if (!c || !c.targetNodeId || !c.note) return false
    let ok = false
    try {
      ok = useRelay.getState().enqueueForTarget(c.targetNodeId, c.note)
    } catch {
      ok = false
    }
    if (ok) {
      set((s) => {
        const next = new Set(s.sent)
        next.add(c.id)
        return { sent: next }
      })
    }
    return ok
  }
}))
