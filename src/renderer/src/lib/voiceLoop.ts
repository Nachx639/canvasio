// voiceLoop.ts (pure helper)
//
// PURE, import-free (types-only), unit-testable core of the Voice Standup Loop's
// "which question do I voice next?" decision. The store (store/voiceLoop.ts) holds
// the live subscription + cross-store side-effects (speak / route / resolve); this
// module isolates the deterministic SELECTION so it can be locked by a test with no
// DOM, no zustand, no IPC — mirroring lib/stallRescue.ts (isStalled) and
// lib/missionBrief.ts.
//
// The rule: from the live question cards, pick the FIRST card that is
//   - unresolved, AND
//   - attributed to an asking node that still exists (live), AND
//   - not already announced this arm-session,
// and only when nothing is already pending (one-at-a-time, no spam).

/** Minimal structural shape of an Open Question this needs (avoids store import). */
export interface QuestionLike {
  id: string
  text: string
  askingNodeId: string
  askingTitle: string
  resolved: boolean
}

/** The selected reply target to arm + voice, or null when there's nothing to do. */
export interface VoicePick {
  questionId: string
  targetId: string
  askingTitle: string
  text: string
}

/**
 * Deterministically pick the next question to voice, or null.
 *
 * @param cards        live question cards (in bus order; oldest first).
 * @param liveNodeIds  ids of currently-existing terminal nodes.
 * @param announced    ids already voiced this arm-session (don't re-voice).
 * @param hasPending   true when a reply is already awaiting an answer (skip all).
 */
export function pickNextQuestion(
  cards: QuestionLike[],
  liveNodeIds: ReadonlySet<string>,
  announced: ReadonlySet<string>,
  hasPending: boolean
): VoicePick | null {
  // One pending at a time: never overwrite an answer we're already waiting on.
  if (hasPending) return null
  for (const q of cards) {
    if (q.resolved) continue
    if (!q.askingNodeId || !liveNodeIds.has(q.askingNodeId)) continue
    if (announced.has(q.id)) continue
    return {
      questionId: q.id,
      targetId: q.askingNodeId,
      askingTitle: (q.askingTitle || '').trim() || 'Un agente',
      text: q.text
    }
  }
  return null
}
